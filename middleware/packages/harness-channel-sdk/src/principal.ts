/**
 * #333 Phase 1 — `Principal`: the typed form of "who a decision is about".
 *
 * Conductor already has this concept in its schema
 * (`conductor/migrations/0001_conductor.sql:77`,
 * `principal_kind IN ('user', 'role')`) and in a canonicalizer
 * (`conductor/principalId.ts:11`), but only as two loose columns and a bare
 * `string`. Nothing outside Conductor can name a principal, which is why
 * `specs/575-scope-and-identity-foundation/spec.md` §6 assigns the type to
 * #333 and makes it the hand-off to #575:
 *
 * > **#333 produces Principals. #575 consumes Principals and produces
 * > decisions. #575 never resolves an identity; #333 never evaluates a
 * > permission.**
 *
 * Nothing in this file evaluates a permission. It is pure, synchronous, and
 * carries no entitlements — a `Principal` says *who*, never *may they*.
 *
 * It lives in the channel SDK for the same reason `ScopeId` does: the
 * orchestrator, the kernel and `middleware/src` all already depend on this
 * package, and it depends on none of them. Adding exports here is additive —
 * the published plugin contract (D2) is untouched.
 *
 * ## The two kinds do NOT share a canonicalization rule
 *
 * This is the finding that makes a shared `ref: string` field the wrong shape,
 * and it is measured, not assumed:
 *
 *  - **`user`** ids are canonicalized **trim + lowercase**. They arrive from
 *    unrelated sources — a channel plugin's `principalRef` (a Teams email), an
 *    operator-typed role holder, an AAD object id — and the SQL that decides
 *    whether a reminder reaches a person is a case-sensitive `=`
 *    (`channelBindingStore.ts:23,38,50`). Email and UPN ids are
 *    case-insensitive and GUIDs are already lowercase, so folding case is safe
 *    and lossless for every id in that space.
 *  - **`role`** keys are canonicalized **trim only**. `createRole`
 *    (`conductor/roleStore.ts:26`) writes `key` verbatim — it never folds case
 *    — and `resolve()` matches with `role_key = $1`. Lowercasing a role key
 *    here would stop matching every mixed-case row already sitting in a live
 *    deployment's `conductor_roles` table. The asymmetry is not an oversight;
 *    it is the existing data.
 *
 * Collapsing the two rules into one would be a silent routing bug in whichever
 * direction it was collapsed: lowercase roles and approvals stop reaching their
 * holders, preserve user case and a reminder addressed to `Jane@Co.com` never
 * matches the binding stored as `jane@co.com`.
 */

/** The two principal kinds Conductor's schema already constrains to. */
export type PrincipalKind = 'user' | 'role';

/** Iterable form of {@link PrincipalKind}, for validating untrusted input. */
export const PRINCIPAL_KINDS: readonly PrincipalKind[] = Object.freeze(['user', 'role']);

/**
 * Who a turn, an approval or a grant is about.
 *
 * The two variants carry differently-named fields on purpose. A single
 * `ref: string` would read identically at every call site while obeying two
 * different canonicalization rules (see the file header), which is exactly the
 * kind of invisible difference that survives review.
 */
export type Principal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'role'; readonly roleKey: string };

/** The wire separator between a principal's kind and its reference. */
const PRINCIPAL_SEPARATOR = ':';

/**
 * The canonical spelling of a principal reference for its kind.
 *
 * Exported because `middleware/src/conductor/principalId.ts` delegates to it:
 * two implementations of "canonical" that drift apart reintroduce precisely the
 * case-sensitive miss the canonicalizer exists to prevent.
 */
export function canonicalizePrincipalRef(kind: PrincipalKind, ref: string): string {
  const trimmed = ref.trim();
  return kind === 'user' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Builds a `Principal` from a kind and a raw reference, canonicalizing the
 * reference for that kind.
 *
 * Returns `undefined` for an empty reference rather than a principal nobody can
 * match. `roleStore.ts` already had to defend against this shape by hand —
 * `bindingKeyForTurn` uses `||` rather than `??` so a blank `principalRef`
 * falls back instead of writing "an empty, never-matched binding key". Here the
 * emptiness is refused at construction instead.
 */
export function makePrincipal(kind: PrincipalKind, ref: string): Principal | undefined {
  const canonical = canonicalizePrincipalRef(kind, ref);
  if (canonical.length === 0) return undefined;
  return kind === 'user' ? { kind: 'user', userId: canonical } : { kind: 'role', roleKey: canonical };
}

/** The kind-appropriate reference of a principal, as a plain string. */
export function principalRef(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.roleKey;
}

/**
 * Parses the wire form `user:<id>` / `role:<key>`.
 *
 * **Splits on the FIRST separator only.** Principal references legitimately
 * contain colons: `coreApi.resolveIdentity` builds its platform id as
 * `` `${ref.kind}:${ref.id}` `` (`channels/coreApi.ts:111`), so `user:teams:<aad-oid>`
 * is a real value. A naive `split(':')` would either drop everything after the
 * second colon or reject the string outright, and the failure mode is a
 * principal that silently addresses the wrong person.
 *
 * Returns `undefined` — never a `user` — for anything it cannot parse. An
 * unrecognised prefix must not fall back to `{ kind: 'user' }`: a role key
 * misread as a user id routes an approval to a person who does not exist, and
 * the caller is the only layer that knows whether that is recoverable. Same
 * reasoning as `ScopeId`'s `unscoped` variant: the absence is a type, not a
 * value.
 */
export function parsePrincipal(raw: string | undefined): Principal | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const separatorAt = trimmed.indexOf(PRINCIPAL_SEPARATOR);
  if (separatorAt <= 0) return undefined;
  const kind = trimmed.slice(0, separatorAt);
  if (!isPrincipalKind(kind)) return undefined;
  return makePrincipal(kind, trimmed.slice(separatorAt + 1));
}

/**
 * The wire form of a principal — the inverse of {@link parsePrincipal} for any
 * principal that came from {@link makePrincipal} or {@link parsePrincipal},
 * both of which have already canonicalized the reference.
 */
export function formatPrincipal(principal: Principal): string {
  return `${principal.kind}${PRINCIPAL_SEPARATOR}${principalRef(principal)}`;
}

/**
 * Whether two principals address the same subject.
 *
 * A `user` and a `role` are never equal even when their references match — a
 * role key that happens to spell a user id is still a late-bound indirection
 * that `resolveAwaitHolders` (`conductor/awaitStore.ts:26`) expands through the
 * resolver, not a person.
 */
export function principalsEqual(a: Principal, b: Principal): boolean {
  return a.kind === b.kind && principalRef(a) === principalRef(b);
}

function isPrincipalKind(value: string): value is PrincipalKind {
  return (PRINCIPAL_KINDS as readonly string[]).includes(value);
}
