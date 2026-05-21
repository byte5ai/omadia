/**
 * Upstream-repo configuration for native issue-reporting.
 *
 * Defaults to `byte5ai/omadia` with the standard
 * `from-builder-bot` + `needs-triage` labels. Env-overrides let
 * Forks point at a different upstream — but the operator-facing
 * allowlist + setup-wizard warning lands in Block 10 of the plan
 * so an accidental switch (e.g. a Fork still pointing at byte5ai)
 * is caught at first build.
 */

export interface UpstreamIssueConfig {
  owner: string;
  repo: string;
  labels: readonly string[];
}

const DEFAULT_OWNER = 'byte5ai';
const DEFAULT_REPO = 'omadia';
const DEFAULT_LABELS = ['from-builder-bot', 'needs-triage'] as const;

export function loadUpstreamIssueConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpstreamIssueConfig {
  const owner = nonEmpty(env['GITHUB_UPSTREAM_OWNER']) ?? DEFAULT_OWNER;
  const repo = nonEmpty(env['GITHUB_UPSTREAM_REPO']) ?? DEFAULT_REPO;
  const labelsEnv = nonEmpty(env['GITHUB_ISSUE_LABELS']);
  const labels = labelsEnv
    ? labelsEnv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : (DEFAULT_LABELS as readonly string[]);
  return { owner, repo, labels };
}

/**
 * Allowlist of upstream targets the platform happily accepts without
 * an operator-facing confirmation. Anything outside the allowlist
 * surfaces a setup-wizard warning at first build (Block 10).
 */
export const UPSTREAM_ALLOWLIST: ReadonlyArray<{
  owner: string;
  repo: string;
}> = [{ owner: 'byte5ai', repo: 'omadia' }];

export function isUpstreamAllowlisted(config: UpstreamIssueConfig): boolean {
  return UPSTREAM_ALLOWLIST.some(
    (entry) => entry.owner === config.owner && entry.repo === config.repo,
  );
}

function nonEmpty(v: string | undefined): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
