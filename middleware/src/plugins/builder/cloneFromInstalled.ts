import type { DraftStore } from './draftStore.js';
import type { DraftQuota } from './draftQuota.js';
import { QuotaExceededError } from './draftQuota.js';
import type { Draft } from './types.js';

/**
 * Edit-from-Store orchestrator (B.6-3).
 *
 * Resolves the source draft for an installed agent and clones its spec +
 * slots + transcript-stripped state into a new draft owned by the same
 * user. The previously-installed plugin stays live; the new draft starts
 * in `status='draft'` with a fresh `id` and no `installed_agent_id` link.
 * The operator can iterate freely; re-installing will route through the
 * normal install-commit (B.6-1) flow + Conflict-Detection (Open Question
 * #2: block on duplicate_version → operator bumps `version` in the spec).
 *
 * Failure modes (mapped to HTTP by the route layer):
 *   source_not_found  → 404  (no draft pinned to that agentId for this
 *                              user — the source draft was hard-deleted
 *                              or another user did the original install)
 *   quota_exceeded    → 409  (the user's draft cap is reached)
 *
 * NOT in scope (B.7+):
 *   - Reverse-engineer a spec from the on-disk installed package when no
 *     source draft exists (would need to parse manifest.yaml + read slot
 *     files). For now: 404 with a hint.
 *   - Locking the installed agent during edit (Open Question #4 chose
 *     "clone, don't lock") — the Plugin stays live + queryable.
 *   - Versions-Branching across multiple in-flight forks of the same
 *     agent — also chosen out per Open Question #4.
 */

export interface CloneFromInstalledDeps {
  draftStore: DraftStore;
  quota: DraftQuota;
  log?: (line: string) => void;
}

export interface CloneFromInstalledInput {
  userEmail: string;
  installedAgentId: string;
}

export type CloneFailureReason = 'source_not_found' | 'quota_exceeded';

export interface CloneSuccess {
  ok: true;
  draftId: string;
  sourceDraftId: string;
  installedAgentId: string;
}

export interface CloneFailure {
  ok: false;
  reason: CloneFailureReason;
  code: string;
  message: string;
  details?: unknown;
}

export type CloneResult = CloneSuccess | CloneFailure;

export async function cloneFromInstalled(
  input: CloneFromInstalledInput,
  deps: CloneFromInstalledDeps,
): Promise<CloneResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { userEmail, installedAgentId } = input;

  // Step 1 — find the source draft. The `installed_agent_id` column is
  // pinned by the install-commit endpoint (B.6-1) when ingest succeeds.
  const source = await deps.draftStore.findByInstalledAgentId(
    userEmail,
    installedAgentId,
  );
  if (!source) {
    return {
      ok: false,
      reason: 'source_not_found',
      code: 'builder.source_draft_not_found',
      message: `Kein Source-Draft für installiertes Plugin '${installedAgentId}' gefunden. Edit-from-Store benötigt den Original-Draft des Builders; eine Reverse-Codegen-Variante aus der installierten manifest.yaml kommt erst in B.7.`,
    };
  }

  // Step 2 — quota check (must come BEFORE create to avoid an orphan row
  // when the user is already at the cap).
  try {
    await deps.quota.assertCanCreate(userEmail);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return {
        ok: false,
        reason: 'quota_exceeded',
        code: err.code,
        message: err.message,
        details: { quota: err.snapshot },
      };
    }
    throw err;
  }

  // Step 3 — create the cloned draft. Use the existing 2-step pattern
  // (`create()` to allocate the row, then `update()` with the cloned
  // payload) so we reuse the canonical mutation paths instead of
  // duplicating the schema knowledge here. Quota was just verified, so
  // the create succeeds.
  const cloneName = buildCloneName(source);
  const fresh = await deps.draftStore.create(userEmail, cloneName);

  // Theme C: auto-bump the patch version so the operator does NOT
  // hit `package.duplicate_version` on re-install. Without this, every
  // edit-cycle starts with the same version-string as what's already
  // installed and the install commit fails until the operator manually
  // edits `spec.version`. The bump strips any prerelease tag and
  // increments the patch segment; if the source version isn't valid
  // semver we leave it untouched and let the install validation catch
  // it (the operator likely typed it manually and is the best judge).
  const bumpedSpec = bumpSpecPatchVersion(source.spec);

  const updated = await deps.draftStore.update(userEmail, fresh.id, {
    spec: bumpedSpec,
    slots: { ...source.slots },
    codegenModel: source.codegenModel,
    previewModel: source.previewModel,
    // Transcripts intentionally NOT cloned — chat history belongs to the
    // original conversation. The new draft starts with an empty Builder-
    // and Preview-chat pane so the operator iterates against the cloned
    // spec, not against stale conversation context.
    transcript: [],
    previewTranscript: [],
    // status defaults to 'draft' from create(); no installed_agent_id
    // link — that gets re-pinned only when the operator runs install
    // again on the cloned draft.
  });

  if (!updated) {
    // Shouldn't happen — we just created the draft. Surface as a generic
    // failure rather than silently returning an inconsistent state.
    log(
      `[clone-from-installed] draft=${fresh.id} created but update returned null — inconsistent state`,
    );
    return {
      ok: false,
      reason: 'source_not_found',
      code: 'builder.clone_update_failed',
      message: `Cloned draft '${fresh.id}' could not be populated.`,
    };
  }

  log(
    `[clone-from-installed] user=${userEmail} agent=${installedAgentId} source=${source.id} → new draft=${updated.id}`,
  );

  return {
    ok: true,
    draftId: updated.id,
    sourceDraftId: source.id,
    installedAgentId,
  };
}

// ---------------------------------------------------------------------------

/**
 * Strip any prerelease tag and increment the patch segment of a semver
 * string. Returns the bumped string. If the input is not a valid semver
 * (operator-typed garbage), returns it unchanged so the install layer
 * surfaces a real validation error to the operator instead of us
 * silently rewriting the field.
 *
 * Examples:
 *   '0.1.0'         → '0.1.1'
 *   '1.2.3'         → '1.2.4'
 *   '1.2.3-alpha.4' → '1.2.4'
 *   '0.0.0'         → '0.0.1'
 *   'whatever'      → 'whatever'   (defensive — caller decides)
 */
export function bumpPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(version);
  if (!m) return version;
  const [, major, minor, patch] = m;
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
}

/**
 * Pure helper that returns a new spec object with `version` patch-bumped.
 * Operates on the AgentSpecSkeleton shape directly so it can be used both
 * for the typed AgentSpec (post Zod-parse) and the looser draft-time
 * skeleton.
 */
export function bumpSpecPatchVersion<T extends { version?: unknown }>(spec: T): T {
  const current = typeof spec.version === 'string' ? spec.version : '';
  if (current.length === 0) return spec;
  return { ...spec, version: bumpPatchVersion(current) };
}

function buildCloneName(source: Draft): string {
  const base = source.name.trim();
  // If the name already ends with " (Kopie)" or " (Kopie N)", bump the N
  // so successive clones don't pile up identical "Foo (Kopie) (Kopie)".
  const m = base.match(/^(.*) \(Kopie(?: (\d+))?\)$/);
  if (m && typeof m[1] === 'string') {
    const n = m[2] ? Number(m[2]) + 1 : 2;
    return `${m[1]} (Kopie ${String(n)})`.slice(0, 200);
  }
  return `${base} (Kopie)`.slice(0, 200);
}
