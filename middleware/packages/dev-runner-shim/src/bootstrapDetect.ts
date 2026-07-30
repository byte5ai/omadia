/**
 * Epic #470 W2 — auto-detect a dependency-install command when the repo has no
 * explicit `bootstrap_command` configured (`types.ts`'s own doc comment: "null
 * = auto-detect at runtime"). Runs shim-side, not server-side: the middleware
 * derives job policy before the repo is even cloned, so it has no filesystem to
 * inspect — only the runner, once the workspace exists, can look.
 *
 * Root-level only: this looks at the CLONED REPO ROOT's own manifest/lockfile,
 * not any subdirectory. A monorepo with per-workspace-directory manifests (no
 * root `package.json`, e.g. `middleware/package.json` + `web-ui/package.json`
 * with nothing at root) will not match anything here — that's intentional
 * (see `detectBootstrapCommand`'s doc comment) rather than guessing which
 * subdirectories matter; those repos need an explicit `bootstrap_command`.
 */

/** npm-family lockfiles, checked ONLY when `package.json` is also present (see
 *  `detectBootstrapCommand`) — a lockfile alone is not installable: `npm ci`
 *  requires both files and fails outright without a manifest. Found live: a
 *  stray root `package-lock.json` (an 87-byte empty-packages stub, left over
 *  from before this repo moved to per-workspace-directory manifests) with no
 *  matching `package.json` made the old file-alone check run `npm ci` anyway
 *  and fail with exit 254. */
const NPM_LOCKFILE_CHECKS: readonly { file: string; command: string }[] = [
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
];

/** Checks with no `package.json`-style prerequisite — each file IS the whole
 *  signal for its ecosystem. */
const STANDALONE_CHECKS: readonly { file: string; command: string }[] = [
  { file: 'requirements.txt', command: 'pip install -r requirements.txt' },
  { file: 'Pipfile', command: 'pipenv install' },
  { file: 'Cargo.toml', command: 'cargo fetch' },
  { file: 'go.mod', command: 'go mod download' },
];

/**
 * `entries` is the repo root's directory listing. Returns the first matching
 * command in priority order (a lockfile beats the bare manifest — `npm ci`
 * over `npm install` when both `package-lock.json` and `package.json` are
 * present), or `null` when nothing recognizable is there — not every repo
 * needs a distinct install step, and an undetectable one is not itself a
 * failure.
 */
export function detectBootstrapCommand(entries: readonly string[]): string | null {
  const present = new Set(entries);
  if (present.has('package.json')) {
    for (const check of NPM_LOCKFILE_CHECKS) {
      if (present.has(check.file)) return check.command;
    }
    return 'npm install';
  }
  for (const check of STANDALONE_CHECKS) {
    if (present.has(check.file)) return check.command;
  }
  return null;
}
