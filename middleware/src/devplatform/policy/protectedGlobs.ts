/**
 * Epic #470 W3 — protected-path glob defaults + a tiny, zero-dependency glob
 * matcher for the diff policy engine.
 *
 * No glob library exists in the middleware dependency tree (verified: no
 * minimatch/micromatch/picomatch), and pulling one into a security-critical,
 * prompt-injection-adjacent path is the wrong trade — the same reasoning that
 * kept parseUnifiedDiff zero-dep. The matcher below supports exactly the glob
 * subset the rule table needs: `**` (any run of path segments, incl. zero),
 * `*` (any run of non-`/` chars), and `?` (a single non-`/` char). Paths are
 * matched as repo-relative POSIX paths (the parser already strips `a/`/`b/`).
 */

/**
 * Default protected paths (gate, rule `protected-ci`):
 *   - CI / workflow / hook definitions — a diff that rewrites how the repo
 *     builds, tests, or deploys deserves a human look.
 *   - Credential-handling FILE paths — a `.env`/key file can be added with
 *     placeholder content that trips no entropy rule yet still must be reviewed.
 *     (Credential CONTENT is the stronger, non-overridable `credential-content`
 *     deny; this is the weaker path-shaped gate that complements it.)
 */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  // CI / workflow / build automation
  '.github/workflows/**',
  '**/action.yml',
  '**/action.yaml',
  '**/Dockerfile*',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/**',
  '.husky/**',
  // credential-handling file paths
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_dsa',
  '**/*.pfx',
  '**/*.p12',
];

/** Compile a single glob to an anchored RegExp. Pure, deterministic. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second '*'
        if (glob[i + 1] === '/') {
          i++; // consume the trailing '/'
          re += '(?:.*/)?'; // '**/' → zero or more leading path segments
        } else {
          re += '.*'; // trailing '**' → anything, crossing '/'
        }
      } else {
        re += '[^/]*'; // single '*' → non-separator run
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|[]{}'.includes(c)) {
      re += '\\' + c; // escape regex metacharacters (note: '/' is not special)
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Normalize a repo path for matching: drop a leading `./`, collapse `\` to `/`. */
export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, '/');
  return p.startsWith('./') ? p.slice(2) : p;
}

/** True if `path` matches any glob in `globs`. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const norm = normalizePath(path);
  for (const g of globs) {
    if (globToRegExp(g).test(norm)) return true;
  }
  return false;
}
