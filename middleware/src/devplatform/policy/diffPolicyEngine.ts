/**
 * Epic #470 W3 — the AUTHORITATIVE diff policy engine.
 *
 * This is the gate that decides whether a runner's uploaded diff may be applied
 * by the middleware. It is PURE and prompt-injection-proof: it reasons only over
 * the parsed diff, the uploaded `--numstat`, and outbound text — never over an
 * LLM's say-so. The W2 UI's plan approval is advisory; THIS verdict is binding
 * (W0 shipped a stub returning `allow`; W3 fills in the rules).
 *
 * Rule set (spec §6). Verdict precedence is deterministic:
 *   any `deny` finding  → deny   (even if gates are also present)
 *   else any `gate`     → gate
 *   else                → allow
 *
 * | ruleId                 | trigger                                   | severity |
 * |------------------------|-------------------------------------------|----------|
 * | git-internals          | path under `.git/` or with a `..` segment | deny     |
 * | credential-content     | secret in diff / PR body / tracker comment| deny*    |
 * | protected-ci           | CI / workflow / credential-file paths     | gate     |
 * | dep-manifest-lockfile  | a dependency manifest is touched          | gate     |
 * | max-files              | > maxFiles files touched                   | gate     |
 * | max-added-lines        | > maxAddedLines added lines               | gate     |
 * | diff-integrity         | parser totals ≠ uploaded numstat          | gate     |
 *  * non-overridable.
 *
 * Reconciliation note (spec §6 vs. this build): the spec table lists
 * `protected-ci`, `dep-manifest-lockfile`, `lockfile-only`, `max-files`,
 * `max-added-lines`, `git-internals`, `binary-blob`, `credential-content`,
 * `diff-integrity`. This build follows the W3 task's refined manifest semantics
 * — a *lockfile-only* change is ALLOWED and a *manifest* change GATES — so the
 * `lockfile-only` gate is intentionally not emitted. `binary-blob` (new binary
 * file > 1 MiB) is deferred: neither the parser nor `--numstat` carries a byte
 * size, so it belongs with the artifact-upload layer that does. All other spec
 * rule ids are implemented verbatim.
 */

import {
  parseUnifiedDiff,
  parseUnifiedDiffDetailed,
  type DiffFileChange,
  type DiffFileStat,
} from './parseUnifiedDiff.js';
import { scanForSecrets } from './scanForSecrets.js';
import { DEFAULT_PROTECTED_GLOBS, matchesAnyGlob, normalizePath } from './protectedGlobs.js';

export type PolicyDecision = 'allow' | 'gate' | 'deny';

export interface PolicyFinding {
  ruleId: string;
  severity: 'gate' | 'deny';
  paths: string[];
  detail: string;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  findings: PolicyFinding[];
  stats: { filesTouched: number; additions: number; deletions: number; binaries: number };
}

/**
 * Operator overrides (`dev_repos.policy_overrides`). Merge is subtract-then-add
 * over code defaults and can NEVER remove a `deny` rule.
 */
export interface DiffPolicyOverrides {
  maxFiles?: number;
  maxAddedLines?: number;
  extraProtectedGlobs?: string[];
  unprotectedGlobs?: string[];
}

/** One entry of the runner-uploaded `git diff --numstat` (binary → `-`/`-`). */
export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface DiffPolicyInput {
  /** The unified diff text (`git diff --binary --cached`). */
  diff: string;
  /** The separately uploaded `--numstat`, for the integrity cross-check. */
  numstat: NumstatEntry[];
  /** The outbound PR body — scanned for secrets. */
  prBody?: string;
  /** Every outbound tracker comment — scanned for secrets. */
  trackerComments?: string[];
  /** The repo's operator overrides. */
  policyOverrides?: DiffPolicyOverrides;
  /** The job's own token/nonce values, for the secret scan. REQUIRED (Forge W3):
   *  an optional field failed OPEN — a caller that forgot it silently skipped the
   *  job's-own-token detector. Pass `[]` only if the job genuinely has no tokens. */
  jobTokens: string[];
}

export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_ADDED_LINES = 5000;

/** Dependency manifest ↔ lockfile families (spec §6). Matched by basename. */
const DEP_MANIFEST_BASENAMES: readonly string[] = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
];

function basename(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** Every path a file touches — new path plus, for renames/copies/deletes, old. */
function pathsOf(f: DiffFileStat): string[] {
  const out = [f.path];
  if (f.oldPath && f.oldPath !== f.path) out.push(f.oldPath);
  return out;
}

/** A path is a git-internals violation: under `.git/`, or has a `..` segment.
 *  Case-folded (Forge W3): `.GIT/` resolves into `.git/` on case-insensitive
 *  filesystems, so a case-sensitive check let it through. */
function isGitInternals(path: string): boolean {
  const segments = normalizePath(path).split('/');
  return segments.some((s) => s.toLowerCase() === '.git') || segments.includes('..');
}

/**
 * Evaluate the diff policy. Deterministic: same input → same verdict.
 */
export function evaluateDiffPolicy(input: DiffPolicyInput): PolicyVerdict {
  // Parse ONCE, structured: the detailed parse separates the `+++ b/path` header
  // from hunk body lines, so added content is read from the parser (Forge W3 —
  // a raw `line.startsWith('+++')` guard mistook an added line whose content
  // begins with `++` for the header and skipped the secret on it). It also
  // carries file `mode`, needed for the symlink-target check.
  const detailed = parseUnifiedDiffDetailed(input.diff);
  const files: DiffFileStat[] = parseUnifiedDiff(input.diff);
  const stats = {
    filesTouched: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    binaries: files.reduce((s, f) => s + (f.binary ? 1 : 0), 0),
  };

  const overrides = input.policyOverrides ?? {};
  const maxFiles = overrides.maxFiles ?? DEFAULT_MAX_FILES;
  const maxAddedLines = overrides.maxAddedLines ?? DEFAULT_MAX_ADDED_LINES;

  const findings: PolicyFinding[] = [];

  // --- git-internals (deny, non-overridable) -------------------------------
  // Structurally separate from every override knob; nothing can disable it.
  const gitInternalsPaths = files.flatMap(pathsOf).filter(isGitInternals);
  // A symlink (mode 120000) at a benign PATH whose TARGET (its added content) is
  // `.git/…` or escapes via `..` resolves into git internals / outside the tree
  // on checkout (Forge W3). The path check alone misses it, so scan the target.
  for (const f of detailed) {
    if (f.mode === '120000') {
      const target = addedLinesOf(f).join('').trim();
      if (target && isGitInternals(target)) gitInternalsPaths.push(`${f.path} → ${target}`);
    }
  }
  if (gitInternalsPaths.length > 0) {
    findings.push({
      ruleId: 'git-internals',
      severity: 'deny',
      paths: unique(gitInternalsPaths),
      detail: 'diff touches — or symlinks into — a path under .git/ or containing a `..` segment',
    });
  }

  // --- credential-content (deny, non-overridable) --------------------------
  // Scans the diff's ADDED CONTENT (not its git metadata) plus every piece of
  // outbound text. Scanning raw diff metadata would false-positive on the
  // 40-char blob hashes `git diff --binary` (== --full-index) emits on every
  // `index <sha1>..<sha2>` line; removed lines are a deletion, not a leak.
  const credPaths = new Set<string>();
  const credKinds = new Set<string>();
  // Added content, per-line AND whitespace-collapsed-joined. The join catches a
  // secret split across two `+` lines (Forge W3) that a per-line regex misses.
  const addedLines = detailed.flatMap(addedLinesOf);
  const addedContent = addedLines.join('\n');
  const addedJoined = addedLines.join('').replace(/\s+/g, '');
  for (const s of [
    ...scanForSecrets(addedContent, input.jobTokens),
    ...scanForSecrets(addedJoined, input.jobTokens),
  ]) {
    credKinds.add(s.kind);
    credPaths.add('<diff>');
  }
  if (input.prBody) {
    for (const s of scanForSecrets(input.prBody, input.jobTokens)) {
      credKinds.add(s.kind);
      credPaths.add('<pr-body>');
    }
  }
  for (let i = 0; i < (input.trackerComments?.length ?? 0); i++) {
    const comment = input.trackerComments![i]!;
    for (const s of scanForSecrets(comment, input.jobTokens)) {
      credKinds.add(s.kind);
      credPaths.add(`<tracker-comment[${i}]>`);
    }
  }
  if (credKinds.size > 0) {
    findings.push({
      ruleId: 'credential-content',
      severity: 'deny',
      paths: [...credPaths].sort(),
      detail: `outbound text contains secret-shaped content: ${[...credKinds].sort().join(', ')}`,
    });
  }

  // --- protected-ci (gate, overridable) ------------------------------------
  // Effective protected set = (defaults + extraProtectedGlobs) with any path
  // matching an unprotectedGlob exempted. Subtract-then-add; touches only this
  // gate rule — it can never reach a deny rule.
  const protectedGlobs = [...DEFAULT_PROTECTED_GLOBS, ...(overrides.extraProtectedGlobs ?? [])];
  const unprotected = overrides.unprotectedGlobs ?? [];
  const protectedPaths = files
    .flatMap(pathsOf)
    .filter((p) => matchesAnyGlob(p, protectedGlobs) && !matchesAnyGlob(p, unprotected));
  if (protectedPaths.length > 0) {
    findings.push({
      ruleId: 'protected-ci',
      severity: 'gate',
      paths: unique(protectedPaths),
      detail: 'diff touches a protected CI / workflow / credential-handling path',
    });
  }

  // --- dep-manifest-lockfile (gate, overridable via unprotectedGlobs) ------
  // A dependency-manifest change gates; a lockfile-only change is allowed.
  const manifestPaths = files
    .flatMap(pathsOf)
    .filter((p) => DEP_MANIFEST_BASENAMES.includes(basename(p)) && !matchesAnyGlob(p, unprotected));
  if (manifestPaths.length > 0) {
    findings.push({
      ruleId: 'dep-manifest-lockfile',
      severity: 'gate',
      paths: unique(manifestPaths),
      detail: 'diff changes a dependency manifest',
    });
  }

  // --- max-files (gate, overridable) ---------------------------------------
  if (stats.filesTouched > maxFiles) {
    findings.push({
      ruleId: 'max-files',
      severity: 'gate',
      paths: [],
      detail: `diff touches ${stats.filesTouched} files (limit ${maxFiles})`,
    });
  }

  // --- max-added-lines (gate, overridable) ---------------------------------
  if (stats.additions > maxAddedLines) {
    findings.push({
      ruleId: 'max-added-lines',
      severity: 'gate',
      paths: [],
      detail: `diff adds ${stats.additions} lines (limit ${maxAddedLines})`,
    });
  }

  // --- diff-integrity (gate, non-overridable) ------------------------------
  // The parser totals must equal the uploaded numstat, or a runner could
  // understate its own diff to slip past the line/file gates.
  const integrity = checkIntegrity(files, input.numstat);
  if (!integrity.ok) {
    findings.push({
      ruleId: 'diff-integrity',
      severity: 'gate',
      paths: [],
      detail: integrity.detail,
    });
  }

  const decision: PolicyDecision = findings.some((f) => f.severity === 'deny')
    ? 'deny'
    : findings.some((f) => f.severity === 'gate')
      ? 'gate'
      : 'allow';

  return { decision, findings, stats };
}

function checkIntegrity(
  files: DiffFileStat[],
  numstat: NumstatEntry[],
): { ok: boolean; detail: string } {
  const parsed = {
    files: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
  };
  const uploaded = {
    files: numstat.length,
    additions: numstat.reduce((s, e) => s + (e.binary ? 0 : e.additions), 0),
    deletions: numstat.reduce((s, e) => s + (e.binary ? 0 : e.deletions), 0),
  };
  if (
    parsed.files === uploaded.files &&
    parsed.additions === uploaded.additions &&
    parsed.deletions === uploaded.deletions
  ) {
    return { ok: true, detail: '' };
  }
  return {
    ok: false,
    detail:
      `parsed diff (${parsed.files} files, +${parsed.additions}/-${parsed.deletions}) ` +
      `disagrees with uploaded numstat (${uploaded.files} files, +${uploaded.additions}/-${uploaded.deletions})`,
  };
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

/**
 * Extract only the ADDED content of a unified diff — lines beginning with a
 * single `+` (the `+++` file header is excluded), with the marker stripped.
 * This is what may leak to the branch; git metadata (`diff --git`, `index`,
 * `@@` hunk headers) and removed lines are deliberately not scanned.
 */
/**
 * The added-content lines of a parsed file — from the STRUCTURED parser's hunk
 * bodies, never a raw-string `startsWith('+++')` guard. The parser already split
 * the `+++ b/path` header off, so a hunk line `+++<content>` is unambiguously an
 * added line whose content is `++<content>` (Forge W3 — the string guard skipped
 * exactly that line, letting a secret prefixed with `++` slip the credential deny).
 */
function addedLinesOf(f: DiffFileChange): string[] {
  const out: string[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.charAt(0) === '+') out.push(l.slice(1));
    }
  }
  return out;
}
