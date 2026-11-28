import { adminJson, arrayField } from './adminJson';

/**
 * #2320 — typed client for the skill admin surface (ADR-0068):
 * `GET /v1/admin/skills` and `POST /v1/admin/skills/:id/promote`. A skill
 * reaches a team (`group`) or organisation (`org`) home only by promotion of
 * an already published, owned skill; the server decides, `promotable` only
 * mirrors that rule.
 */

export type SkillLifecycleStatus = 'draft' | 'reviewed' | 'published' | 'archived';

export interface AdminSkillDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** `personal:<id>` / `group:<ref>` / `org:<id>`; null = legacy, unowned. */
  readonly owner_scope: string | null;
  readonly lifecycle_status: SkillLifecycleStatus;
  readonly manifest_signed_at: string | null;
  readonly updated_at: string;
  /** null = the skill's frontmatter value is malformed. */
  readonly required_capabilities: readonly string[] | null;
  readonly promotable: boolean;
}

export type SkillPromotionTarget =
  | { readonly kind: 'group'; readonly groupRef: string }
  | { readonly kind: 'org'; readonly orgId: string };

const SKILLS = '/v1/admin/skills';

export async function listAdminSkills(): Promise<AdminSkillDto[]> {
  return arrayField<AdminSkillDto>(await adminJson(SKILLS), 'skills', SKILLS);
}

export async function promoteSkill(skillId: string, targetScope: SkillPromotionTarget): Promise<void> {
  await adminJson(`${SKILLS}/${encodeURIComponent(skillId)}/promote`, {
    method: 'POST',
    body: { targetScope },
  });
}
