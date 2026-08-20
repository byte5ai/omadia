/**
 * #577 P1 — Postgres-backed store for the ownership + lifecycle columns added
 * by `migrations/0040_skill_ownership_lifecycle.sql`.
 *
 * Deliberately a THIN, standalone store over raw SQL rather than a new method
 * on `AgentGraphStore` (`packages/harness-orchestrator`): the ownership +
 * lifecycle surface is owned by #577 end-to-end (model, migration, store),
 * and staying out of the orchestrator package keeps this phase's blast radius
 * to `src/services/skill*` — see the #577 phase-cut's binding surface
 * separation from the parallel #578 (Keychain) session. `computeSkillHash` is
 * still reused from `@omadia/orchestrator` (same hash the import pipeline
 * already computes) rather than reimplemented here.
 */

import type { Pool } from 'pg';
import { computeSkillHash } from '@omadia/orchestrator';
import { formatSessionScope, parseSessionScope, type ScopeId } from '@omadia/channel-sdk';

import {
  assertHumanActor,
  canonicalSkillManifest,
  isSkillOwnerScope,
  requiredCapabilitiesFromFrontmatter,
  signSkillManifest,
  transitionSkillLifecycle,
  type SkillLifecycleStatus,
  type SkillLifecycleTransitionResult,
  type SkillOwnerScope,
} from './skillLifecycle.js';

export interface SkillOwnershipLifecycleRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  /** Wire form of the owner `ScopeId` (`personal:…` / `group:…` / `org:…`). Null = unowned. */
  readonly ownerScope: string | null;
  readonly lifecycleStatus: SkillLifecycleStatus;
  readonly manifestSignature: string | null;
  readonly manifestSignedAt: Date | null;
}

interface SkillOwnershipLifecycleDbRow {
  id: string;
  slug: string;
  name: string;
  frontmatter: Record<string, unknown> | null;
  body: string | null;
  owner_scope: string | null;
  lifecycle_status: SkillLifecycleStatus;
  manifest_signature: string | null;
  manifest_signed_at: Date | null;
}

function mapRow(r: SkillOwnershipLifecycleDbRow): SkillOwnershipLifecycleRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    frontmatter: r.frontmatter ?? {},
    body: r.body ?? '',
    ownerScope: r.owner_scope,
    lifecycleStatus: r.lifecycle_status,
    manifestSignature: r.manifest_signature,
    manifestSignedAt: r.manifest_signed_at,
  };
}

/**
 * Thrown by `transition()` when the move is illegal, the publish gate isn't
 * satisfied, or the row has no valid owner scope to sign against. Carries the
 * structured reason from `transitionSkillLifecycle` so a route layer (P3) can
 * map it to the right HTTP status without string-matching `message`.
 */
export class SkillLifecycleTransitionRejected extends Error {
  readonly reason: Exclude<SkillLifecycleTransitionResult, { ok: true }>['reason'];
  readonly missing?: readonly string[];

  constructor(result: Exclude<SkillLifecycleTransitionResult, { ok: true }>) {
    super(
      result.reason === 'missing-capabilities'
        ? `skill publish blocked: missing capabilities [${result.missing.join(', ')}]`
        : `skill lifecycle transition rejected: ${result.reason}`,
    );
    this.name = 'SkillLifecycleTransitionRejected';
    this.reason = result.reason;
    if (result.reason === 'missing-capabilities') this.missing = result.missing;
  }
}

export class PgSkillOwnershipLifecycleStore {
  constructor(private readonly pool: Pool) {}

  async getSkill(skillId: string): Promise<SkillOwnershipLifecycleRow | undefined> {
    const result = await this.pool.query<SkillOwnershipLifecycleDbRow>(
      `SELECT id, slug, name, frontmatter, body, owner_scope, lifecycle_status,
              manifest_signature, manifest_signed_at
         FROM skills WHERE id = $1`,
      [skillId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /**
   * Assign a PERSONAL owner to a still-unowned draft skill. This is the ONLY
   * direct-assignment path: #577 Kernkonzept #5 forbids creating a skill
   * directly in team/org scope — those homes are reached only through
   * {@link promoteSkillOwnerScope} (admin-gated, P3). Refuses to reassign an
   * already-owned skill (call `promoteSkillOwnerScope` for that) and refuses a
   * non-draft target (ownership must be settled before review begins, since
   * `ownerScope` is part of what gets signed).
   *
   * `actorScope` is who is performing the write — checked by
   * {@link assertHumanActor} (#577 Kernkonzept #6) BEFORE any query runs, so
   * an automation actor never even reaches the database.
   */
  async assignPersonalOwner(
    skillId: string,
    owner: Extract<ScopeId, { kind: 'personal' }>,
    actorScope: ScopeId,
  ): Promise<void> {
    assertHumanActor(actorScope);
    const result = await this.pool.query(
      `UPDATE skills SET owner_scope = $2, updated_at = now()
         WHERE id = $1 AND owner_scope IS NULL AND lifecycle_status = 'draft'`,
      [skillId, formatSessionScope(owner)],
    );
    if ((result.rowCount ?? 0) === 0) {
      const existing = await this.getSkill(skillId);
      if (!existing) throw new Error(`skill ${skillId} not found`);
      if (existing.ownerScope !== null) {
        throw new Error(`skill ${skillId} already has an owner scope (${existing.ownerScope}) — reassignment requires promotion`);
      }
      throw new Error(`skill ${skillId} is not a draft (status: ${existing.lifecycleStatus}) — cannot assign an owner`);
    }
  }

  /**
   * Move a skill's lifecycle status, re-signing its manifest on success.
   * Throws `SkillLifecycleTransitionRejected` for every rejected move — never
   * returns a "false-ish" result a caller could accidentally ignore. Checks
   * {@link assertHumanActor} first, same as every other mutating method here.
   */
  async transition(
    skillId: string,
    targetStatus: SkillLifecycleStatus,
    opts: { readonly granted: ReadonlySet<string>; readonly signingKey: string; readonly actorScope: ScopeId },
  ): Promise<SkillOwnershipLifecycleRow> {
    assertHumanActor(opts.actorScope);
    const row = await this.getSkill(skillId);
    if (!row) throw new Error(`skill ${skillId} not found`);
    if (row.ownerScope === null) {
      throw new SkillLifecycleTransitionRejected({ ok: false, reason: 'invalid-owner-scope' });
    }
    const ownerScopeParsed = parseSessionScope(row.ownerScope);
    const contentHash = computeSkillHash(row.frontmatter, row.body);
    const requiredCapabilities = requiredCapabilitiesFromFrontmatter(row.frontmatter);

    const result = transitionSkillLifecycle({
      manifest: { slug: row.slug, name: row.name, ownerScope: row.ownerScope, contentHash, requiredCapabilities },
      ownerScope: ownerScopeParsed,
      currentStatus: row.lifecycleStatus,
      targetStatus,
      granted: opts.granted,
      signingKey: opts.signingKey,
    });
    if (!result.ok) throw new SkillLifecycleTransitionRejected(result);

    const updated = await this.pool.query<SkillOwnershipLifecycleDbRow>(
      `UPDATE skills SET lifecycle_status = $2, manifest_signature = $3, manifest_signed_at = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, slug, name, frontmatter, body, owner_scope, lifecycle_status,
                   manifest_signature, manifest_signed_at`,
      [skillId, result.status, result.signature, result.signedAt],
    );
    if (!updated.rows[0]) throw new Error(`skill ${skillId} vanished during transition`);
    return mapRow(updated.rows[0]);
  }

  /**
   * Admin-gated promotion: move an ALREADY-PUBLISHED skill to a team (`group`)
   * or org home. This is the only way a skill ever reaches team/org
   * ownership — #577 Kernkonzept #5 forbids creating one there directly, and
   * `assignPersonalOwner` above only ever assigns `personal`. Callers are
   * responsible for the "admin-gated" half (an authenticated-session check at
   * the route layer, P3/P4 — this method has no notion of roles); what it
   * enforces itself is:
   *
   *  - {@link assertHumanActor} — a cron may not promote a skill, same as it
   *    may not do anything else to one (#577 Kernkonzept #6);
   *  - the skill must currently be `published` — an unreviewed draft has no
   *    business reaching a wider audience, and archiving/promoting are not
   *    composable (an archived skill must be republished first, if that ever
   *    becomes a supported path);
   *  - the manifest is re-signed at the NEW `ownerScope`, same `published`
   *    status — `ownerScope` is a signed field (#577 P1), so a promotion IS a
   *    signature-changing event, not just a column update.
   */
  async promoteSkillOwnerScope(
    skillId: string,
    targetScope: Extract<SkillOwnerScope, { kind: 'group' | 'org' }>,
    opts: { readonly actorScope: ScopeId; readonly signingKey: string },
  ): Promise<SkillOwnershipLifecycleRow> {
    assertHumanActor(opts.actorScope);
    const row = await this.getSkill(skillId);
    if (!row) throw new Error(`skill ${skillId} not found`);
    if (row.ownerScope === null) {
      throw new Error(`skill ${skillId} has no owner scope yet — assign one before promoting`);
    }
    if (row.lifecycleStatus !== 'published') {
      throw new Error(`skill ${skillId} is not published (status: ${row.lifecycleStatus}) — only a published skill may be promoted`);
    }

    const newOwnerScope = formatSessionScope(targetScope);
    const contentHash = computeSkillHash(row.frontmatter, row.body);
    const requiredCapabilities = requiredCapabilitiesFromFrontmatter(row.frontmatter);
    const signature = signSkillManifest(
      {
        slug: row.slug,
        name: row.name,
        ownerScope: newOwnerScope,
        status: row.lifecycleStatus,
        contentHash,
        requiredCapabilities,
      },
      opts.signingKey,
    );

    const updated = await this.pool.query<SkillOwnershipLifecycleDbRow>(
      `UPDATE skills SET owner_scope = $2, manifest_signature = $3, manifest_signed_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING id, slug, name, frontmatter, body, owner_scope, lifecycle_status,
                   manifest_signature, manifest_signed_at`,
      [skillId, newOwnerScope, signature],
    );
    if (!updated.rows[0]) throw new Error(`skill ${skillId} vanished during promotion`);
    return mapRow(updated.rows[0]);
  }
}

/** Re-exported for callers that only need to verify a row without a Pool (e.g. a webhook). */
export { canonicalSkillManifest, isSkillOwnerScope };
