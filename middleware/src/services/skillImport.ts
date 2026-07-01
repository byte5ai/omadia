import { computeSkillHash, type SkillInput, type SkillRow } from '@omadia/orchestrator';

import { parseSkillMarkdown } from './skillLoader.js';
import { scanSkillForRisks, type SkillRisk } from './skillGuard.js';

/**
 * Skill import (epic #391, Part 1). Turns a raw SKILL.md string (pasted or read
 * from an uploaded file) into a first-class registry skill, keyed for
 * convergence: identical content is a no-op, a changed version of an already
 * imported skill updates in place, and everything else is created as a
 * `source:'file'` skill. Only the SKILL.md body + frontmatter are ingested —
 * bundled executable code never enters through here (that is the signed plugin
 * path); callers should surface that to the user.
 */

export interface SkillImportRequest {
  /** Raw SKILL.md text (frontmatter + body). */
  readonly raw: string;
  /** Optional provenance path (e.g. the original file/folder name). */
  readonly sourcePath?: string;
}

export interface NormalizedSkill {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  readonly sourcePath: string | null;
}

export type ImportOutcome = 'created' | 'updated' | 'unchanged';

export interface SkillImportResult {
  readonly outcome: ImportOutcome;
  /** Normalized skill (drives the preview card). */
  readonly skill: NormalizedSkill;
  readonly contentHash: string;
  /** Heuristic pre-activation risk findings surfaced in the preview. */
  readonly risks: SkillRisk[];
  /** Id of the affected/existing skill (absent for a dry-run create). */
  readonly skillId?: string;
}

/** Minimal store surface the importer needs — keeps it unit-testable. */
export interface SkillImportStore {
  getSkillByContentHash(contentHash: string, source?: 'db' | 'file'): Promise<SkillRow | undefined>;
  getSkillBySlug(slug: string): Promise<SkillRow | undefined>;
  insertSkill(input: SkillInput): Promise<SkillRow | undefined>;
  upsertSkill(input: SkillInput): Promise<SkillRow>;
}

const MAX_SLUG_LEN = 63;

/** lowercase kebab-case slug; falls back to `imported-skill` when empty. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '');
  return slug || 'imported-skill';
}

/** Parse + derive name/slug/description from a raw SKILL.md. */
export function normalizeSkillMarkdown(req: SkillImportRequest): NormalizedSkill {
  const parsed = parseSkillMarkdown(req.raw);
  const fmName = typeof parsed.frontmatter['name'] === 'string' ? parsed.frontmatter['name'].trim() : '';
  const name = fmName || parsed.description || 'Imported skill';
  return {
    slug: slugify(fmName || name),
    name,
    description: parsed.description ?? null,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    sourcePath: req.sourcePath ?? null,
  };
}

/** Find a free slug near `base`, never colliding with an existing row. */
async function uniqueSlug(store: SkillImportStore, base: string): Promise<string> {
  if (!(await store.getSkillBySlug(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, MAX_SLUG_LEN - 5)}-${i}`;
    if (!(await store.getSkillBySlug(candidate))) return candidate;
  }
  throw new Error(`could not find a free slug for "${base}"`);
}

/**
 * Import (or preview) a SKILL.md. `dryRun` computes the outcome without
 * writing. Dedup order:
 *  1. identical content already imported (hash match on a `source:'file'`
 *     row) → `unchanged`, no write. A host `db` skill with identical content
 *     does NOT count — the import still lands as its own file skill.
 *  2. an existing `file` skill from the *same origin file* (same
 *     `sourcePath`) → `updated` in place — this is the "re-import a newer
 *     version" path.
 *  3. otherwise `created`. If the target slug is taken (by any skill,
 *     including a host `db` skill or an unrelated import that merely shares a
 *     name/fallback slug), it is disambiguated to a free slug — a slug clash
 *     is never treated as "the same skill", so nothing is ever clobbered.
 */
export async function importSkillMarkdown(
  store: SkillImportStore,
  req: SkillImportRequest,
  opts: { dryRun?: boolean } = {},
): Promise<SkillImportResult> {
  const normalized = normalizeSkillMarkdown(req);
  const contentHash = computeSkillHash(normalized.frontmatter, normalized.body);
  const risks = scanSkillForRisks(normalized.frontmatter, normalized.body);

  // 1. Already imported, byte-identical → no-op. Scoped to file skills so an
  //    identical host skill can't produce a self-inconsistent "unchanged".
  const byHash = await store.getSkillByContentHash(contentHash, 'file');
  if (byHash) {
    return { outcome: 'unchanged', skill: normalized, contentHash, risks, skillId: byHash.id };
  }

  // 2. Newer version of the same origin file → update in place. Requires a
  //    concrete sourcePath match so unrelated skills that merely share a slug
  //    (e.g. two nameless imports, or a name collision) never overwrite one
  //    another.
  const bySlug = await store.getSkillBySlug(normalized.slug);
  if (
    bySlug &&
    bySlug.source === 'file' &&
    normalized.sourcePath !== null &&
    bySlug.sourcePath === normalized.sourcePath
  ) {
    if (opts.dryRun) {
      return { outcome: 'updated', skill: normalized, contentHash, risks, skillId: bySlug.id };
    }
    const row = await store.upsertSkill({
      slug: bySlug.slug,
      name: normalized.name,
      description: normalized.description,
      body: normalized.body,
      frontmatter: normalized.frontmatter,
      source: 'file',
      sourcePath: normalized.sourcePath,
    });
    return { outcome: 'updated', skill: { ...normalized, slug: bySlug.slug }, contentHash, risks, skillId: row.id };
  }

  // 3. Create, disambiguating the slug against any existing skill.
  const targetSlug = bySlug ? await uniqueSlug(store, normalized.slug) : normalized.slug;
  const created = { ...normalized, slug: targetSlug };
  if (opts.dryRun) {
    return { outcome: 'created', skill: created, contentHash, risks };
  }

  // Race-safe insert: ON CONFLICT DO NOTHING, re-disambiguate if a concurrent
  // writer took the slug between the check and the insert.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? targetSlug : await uniqueSlug(store, normalized.slug);
    const row = await store.insertSkill({
      slug,
      name: normalized.name,
      description: normalized.description,
      body: normalized.body,
      frontmatter: normalized.frontmatter,
      source: 'file',
      sourcePath: normalized.sourcePath,
    });
    if (row) {
      return { outcome: 'created', skill: { ...normalized, slug }, contentHash, risks, skillId: row.id };
    }
  }
  throw new Error(`could not create imported skill "${normalized.slug}" after repeated slug conflicts`);
}
