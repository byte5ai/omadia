/**
 * #577 P1 — skill ownership + lifecycle model.
 *
 * Pure, synchronous decision logic for turning a registry skill (today's flat
 * `skills` row, see `skillImport.ts`) into a scope-owned artifact with a
 * tamper-evident lifecycle:
 *
 *  - `SkillOwnerScope` restricts `ScopeId` (from `@omadia/channel-sdk`, #575)
 *    to the three kinds that can own a skill: `personal`, `group` (= team)
 *    and `org`. A skill cannot be owned by a `conversation`, a `system`
 *    origin or `unscoped` — those aren't homes, they're turn-scoped or absent.
 *  - `SKILL_LIFECYCLE_TRANSITIONS` is the ONLY place that decides which
 *    status moves are legal. `draft → reviewed → published → archived` is the
 *    forward path; `reviewed → draft` (a failed review sends it back) and
 *    `published → archived` are the only other edges. Every other pair
 *    (including same-status "transitions" and archived → anything) is
 *    illegal — archived is terminal, matching the Kernkonzept's "removed ones
 *    archived not deleted" posture for the git-pack step (#577, out of scope
 *    for P1).
 *  - `canonicalSkillManifest` fixes the exact bytes that get HMAC-signed.
 *    "Canonical" means a FIXED field order, a FIXED join, and FIXED
 *    normalization rules for the one field that is a set
 *    (`requiredCapabilities`: sorted for order-independence, but never
 *    case-folded — same precedent as role keys in #724, where canonicalizing
 *    a case-SENSITIVE identifier by lowercasing it silently merges two
 *    different values). An unpinned canonical form makes every signature
 *    verification a coin flip; this module pins it and locks it with a
 *    byte-exact test (`test/skillLifecycle.test.ts`).
 *
 * What this module does NOT do (by design, deferred to later #577 phases):
 *  - it never talks to Postgres (`skillLifecycleStore.ts` does that);
 *  - it never talks to `GrantStore` (#575) — `missingRequiredCapabilities`
 *    takes an already-resolved `granted` set, so P3 (sharing + promotion) is
 *    the one place that has to know how a capability got granted;
 *  - it never resolves shadowing across scopes (P2, `skillLoader.ts`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ScopeId } from '@omadia/channel-sdk';

// ── Ownership ────────────────────────────────────────────────────────────

/** The `ScopeId` kinds that can own a skill: a user, a team, or the org. */
export type SkillOwnerScope = Extract<ScopeId, { kind: 'personal' | 'group' | 'org' }>;

/** Narrows a `ScopeId` to the subset that is valid skill ownership. */
export function isSkillOwnerScope(scope: ScopeId): scope is SkillOwnerScope {
  return scope.kind === 'personal' || scope.kind === 'group' || scope.kind === 'org';
}

// ── Automation write-guard (#577 Kernkonzept #6) ────────────────────────

/**
 * Thrown when a skill-mutating call is attempted by a machine actor. Carries
 * the rejected `ScopeId` so a caller (route layer, log line) can report which
 * automation origin was blocked without re-deriving it from the message.
 */
export class SkillAutomationWriteBlocked extends Error {
  readonly actorScope: ScopeId;

  constructor(actorScope: ScopeId) {
    const origin = actorScope.kind === 'system' ? `:${actorScope.origin}` : '';
    super(
      `skill mutation blocked: actor scope is a machine origin ('${actorScope.kind}${origin}') — only a live human may modify a skill`,
    );
    this.name = 'SkillAutomationWriteBlocked';
    this.actorScope = actorScope;
  }
}

/**
 * "Automations (crons) may not modify skills — as an enforced guard, not a
 * convention" (#577 Kernkonzept #6). `ScopeId`'s own contract (`scopeId.ts`)
 * is what makes this a one-line check rather than a new taxonomy: `kind:
 * 'system'` is explicitly documented there as "no human is present in any of
 * them" — routines, schedules and the Conductor's own automated runs. Every
 * OTHER `ScopeId` kind — including `unscoped` — arises from an actual live
 * turn, so `system` is the exact and only boundary this guard needs.
 *
 * Callers pass the ACTOR's scope (who/what is performing the write), never
 * the skill's `ownerScope` (whose home it is) — those are unrelated axes; an
 * org-owned skill can still be legitimately edited by a live human operator.
 */
export function assertHumanActor(actorScope: ScopeId): void {
  if (actorScope.kind === 'system') {
    throw new SkillAutomationWriteBlocked(actorScope);
  }
}

// ── Lifecycle status ─────────────────────────────────────────────────────

export const SKILL_LIFECYCLE_STATUSES = ['draft', 'reviewed', 'published', 'archived'] as const;
export type SkillLifecycleStatus = (typeof SKILL_LIFECYCLE_STATUSES)[number];

/**
 * The complete legal-edge set. Anything not listed here — including every
 * "stay put" pair and every edge out of `archived` — is illegal. Expressed as
 * an explicit allowlist (not a linear "next status" function) so a reviewer
 * can read the whole state machine in one place, and so the exhaustive test
 * matrix in `skillLifecycle.test.ts` has something concrete to diff against.
 */
const SKILL_LIFECYCLE_EDGES: ReadonlySet<string> = new Set([
  'draft->reviewed',
  'reviewed->draft', // failed review — sent back for edits
  'reviewed->published',
  'published->archived',
]);

/** Whether `from -> to` is a legal lifecycle move. Pure, total, no side effects. */
export function canTransitionSkillLifecycle(
  from: SkillLifecycleStatus,
  to: SkillLifecycleStatus,
): boolean {
  return SKILL_LIFECYCLE_EDGES.has(`${from}->${to}`);
}

// ── Required capabilities (frontmatter-sourced, #577 Kernkonzept #1) ───────

/**
 * Thrown when `frontmatter.requiredCapabilities` is present but malformed.
 * Distinct from `TypeError`/`Error` so callers (and tests) can assert on
 * `instanceof SkillManifestError` rather than string-matching a generic
 * error. Every throw site names the exact field and the value it rejected —
 * the #690 lesson: a parser that silently drops malformed input instead of
 * raising must never come back, and a test that only checks "it throws"
 * without checking the message can't catch a regression to a *different*,
 * wrong error.
 */
export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillManifestError';
  }
}

/**
 * Read+validate `frontmatter.requiredCapabilities`. Absent is valid (empty
 * skill, no gate) and returns `[]`. Present-but-malformed throws
 * `SkillManifestError` naming the exact offending field — it NEVER silently
 * coerces or drops, because a silently-dropped required capability is a
 * publish gate that looks satisfied when it isn't.
 */
export function requiredCapabilitiesFromFrontmatter(
  frontmatter: Record<string, unknown>,
): string[] {
  const raw = frontmatter['requiredCapabilities'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new SkillManifestError(
      `frontmatter.requiredCapabilities must be an array of strings, got ${typeof raw}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new SkillManifestError(
        `frontmatter.requiredCapabilities[${index}] must be a non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  });
  return result;
}

/**
 * Which of `required` are missing from `granted`. Empty result = the publish
 * gate is satisfied. Deliberately a pure set-difference over an
 * already-resolved `granted` set — the caller (P3) is responsible for
 * resolving that set via `GrantStore` (#575); this function has no opinion on
 * WHERE a capability came from, only whether it's present. Case-sensitive:
 * capability identifiers are not role keys, but the same rule applies —
 * never fold case on a value this module didn't mint.
 */
export function missingRequiredCapabilities(
  required: readonly string[],
  granted: ReadonlySet<string>,
): string[] {
  return required.filter((c) => !granted.has(c));
}

/** Whether every required capability is present in `granted`. */
export function canPublishSkill(required: readonly string[], granted: ReadonlySet<string>): boolean {
  return missingRequiredCapabilities(required, granted).length === 0;
}

// ── Canonical manifest + HMAC signature ─────────────────────────────────

/** The facts a skill's tamper-evident signature covers. */
export interface SkillManifestInput {
  readonly slug: string;
  readonly name: string;
  /** Wire form of the owner `ScopeId` (`formatSessionScope` output). */
  readonly ownerScope: string;
  readonly status: SkillLifecycleStatus;
  /** sha256 over {frontmatter, body} — see `@omadia/orchestrator` `computeSkillHash`. */
  readonly contentHash: string;
  readonly requiredCapabilities: readonly string[];
}

/**
 * The canonical, byte-exact serialization that gets HMAC-signed.
 *
 * Fixed field order (an ARRAY of pairs, never an object — so this function's
 * output can never depend on V8's key-insertion-order behavior), fixed `\n`
 * join between fields and `=` between key/value, and exactly one
 * normalization rule: `requiredCapabilities` is deduped and sorted by plain
 * string comparison (codepoint order — NOT locale-aware, NOT case-folded) so
 * that two frontmatter documents differing only in capability *order*
 * produce the same manifest, while two differing in capability *case*
 * ('Foo' vs 'foo') do NOT collapse into one. Every other field is a scalar
 * already owned by its producer (`ownerScope` from `formatSessionScope`,
 * `contentHash` from `computeSkillHash`) and is carried through verbatim.
 *
 * Changing this function's output for any existing input is a signing-format
 * break: every previously-issued signature stops verifying. Locked byte-exact
 * in `test/skillLifecycle.test.ts` for exactly that reason.
 */
export function canonicalSkillManifest(input: SkillManifestInput): string {
  const capabilities = [...new Set(input.requiredCapabilities)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const fields: readonly [string, string][] = [
    ['slug', input.slug],
    ['name', input.name],
    ['ownerScope', input.ownerScope],
    ['status', input.status],
    ['contentHash', input.contentHash],
    ['requiredCapabilities', capabilities.join(',')],
  ];
  return fields.map(([key, value]) => `${key}=${value}`).join('\n');
}

/** HMAC-SHA256 (hex) over the canonical manifest. */
export function signSkillManifest(input: SkillManifestInput, key: string): string {
  return createHmac('sha256', key).update(canonicalSkillManifest(input), 'utf8').digest('hex');
}

/**
 * Constant-time signature verification. Returns `false` (never throws) on any
 * mismatch, including a malformed/wrong-length `signature` — `timingSafeEqual`
 * throws on unequal buffer lengths, which this guards against explicitly so a
 * garbage signature can't turn a `verify` call into an uncaught exception.
 */
export function verifySkillManifestSignature(
  input: SkillManifestInput,
  signature: string,
  key: string,
): boolean {
  const expectedHex = signSkillManifest(input, key);
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
    actual = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}

// ── Combined transition decision ────────────────────────────────────────

export type SkillLifecycleTransitionResult =
  | {
      readonly ok: true;
      readonly status: SkillLifecycleStatus;
      readonly signature: string;
      readonly signedAt: Date;
    }
  | { readonly ok: false; readonly reason: 'invalid-transition' }
  | { readonly ok: false; readonly reason: 'missing-capabilities'; readonly missing: readonly string[] }
  | { readonly ok: false; readonly reason: 'invalid-owner-scope' };

/**
 * The single decision point that combines all three P1 invariants: is the
 * status move legal, is the owner scope a valid skill home, and — only when
 * the target is `published` — are all required capabilities granted. On
 * success it also re-signs the manifest at the NEW status, so a caller can
 * never persist a status change without an up-to-date signature (the
 * tamper-evidence guarantee: `manifest_signature` always covers the row's
 * CURRENT `lifecycle_status`, never a stale one).
 *
 * `granted` is ignored for every target other than `published` — reviewing or
 * archiving a skill never needs a capability lookup, so callers moving
 * between non-publish states can pass an empty set.
 */
export function transitionSkillLifecycle(args: {
  readonly manifest: Omit<SkillManifestInput, 'status'>;
  readonly ownerScope: ScopeId;
  readonly currentStatus: SkillLifecycleStatus;
  readonly targetStatus: SkillLifecycleStatus;
  readonly granted: ReadonlySet<string>;
  readonly signingKey: string;
}): SkillLifecycleTransitionResult {
  if (!isSkillOwnerScope(args.ownerScope)) {
    return { ok: false, reason: 'invalid-owner-scope' };
  }
  if (!canTransitionSkillLifecycle(args.currentStatus, args.targetStatus)) {
    return { ok: false, reason: 'invalid-transition' };
  }
  if (args.targetStatus === 'published') {
    const missing = missingRequiredCapabilities(args.manifest.requiredCapabilities, args.granted);
    if (missing.length > 0) {
      return { ok: false, reason: 'missing-capabilities', missing };
    }
  }
  const manifestAtTarget: SkillManifestInput = { ...args.manifest, status: args.targetStatus };
  const signature = signSkillManifest(manifestAtTarget, args.signingKey);
  return { ok: true, status: args.targetStatus, signature, signedAt: new Date() };
}
