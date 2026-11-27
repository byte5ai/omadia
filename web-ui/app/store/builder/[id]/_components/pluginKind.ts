import type { AgentSpecSkeleton, BuilderPluginKind } from '../../../../_lib/builderTypes';

/**
 * Spec 2042 §5.10 — the Plugin Builder generates capability plugins only:
 * manifest kind `integration` (an external system with credentials) or
 * `tool` (local logic, no credentials).
 *
 * Twin of `effectivePluginKind` in
 * `middleware/src/plugins/builder/agentSpec.ts`; keep both in sync. An
 * explicit `spec.kind` wins; otherwise the kind is `integration` when the
 * spec carries credentials (a parent integration in `depends_on`, an OAuth
 * provider, or a `secret` / `oauth` setup field), else `tool`.
 */
export function effectivePluginKind(
  spec: Pick<AgentSpecSkeleton, 'kind' | 'depends_on' | 'oauth_providers' | 'setup_fields'>,
): BuilderPluginKind {
  if (spec.kind) return spec.kind;
  const hasCredentials =
    (spec.depends_on ?? []).length > 0 ||
    (spec.oauth_providers ?? []).length > 0 ||
    (spec.setup_fields ?? []).some((f) => f.type === 'secret' || f.type === 'oauth');
  return hasCredentials ? 'integration' : 'tool';
}

/** Boilerplate ids before #2049, as drafts stored then may still carry them. */
const LEGACY_TEMPLATE_IDS: Readonly<Record<string, string>> = {
  'agent-integration': 'integration',
  'agent-pure-llm': 'tool',
  'pure-llm': 'tool',
};

/** The boilerplate id of a draft for display; absent = `integration`. */
export function normalizeTemplateId(template: string | undefined): string {
  if (!template) return 'integration';
  return LEGACY_TEMPLATE_IDS[template] ?? template;
}
