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

/**
 * GitHub-App credentials for the optional direct-create path (Issue #206,
 * v1.2). All three are DEPLOYMENT secrets — they live only in the
 * operator's environment, never in the repo. When any is missing the
 * loader returns `null` and the platform stays on browser-submit.
 *
 *   GITHUB_APP_ID                — numeric App id
 *   GITHUB_APP_PRIVATE_KEY       — PEM private key. Newlines may be
 *                                  `\n`-escaped (common in env stores) or
 *                                  the whole PEM base64-encoded.
 *   GITHUB_APP_INSTALLATION_ID   — installation id on the target repo
 */
export function loadGitHubAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): { appId: string; privateKey: string; installationId: string } | null {
  const appId = nonEmpty(env['GITHUB_APP_ID']);
  const rawKey = nonEmpty(env['GITHUB_APP_PRIVATE_KEY']);
  const installationId = nonEmpty(env['GITHUB_APP_INSTALLATION_ID']);
  if (!appId || !rawKey || !installationId) return null;
  return { appId, privateKey: normalizePrivateKey(rawKey), installationId };
}

/**
 * Accepts a PEM with literal `\n` escapes (env-store form) or a base64
 * blob of the whole PEM, and returns a real multi-line PEM string.
 */
function normalizePrivateKey(raw: string): string {
  if (raw.includes('BEGIN')) {
    return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  }
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded;
  } catch {
    // fall through — return as-is and let key parsing fail loudly
  }
  return raw;
}
