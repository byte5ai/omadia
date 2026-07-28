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

const CHECKS: readonly { file: string; command: string }[] = [
  { file: 'package-lock.json', command: 'npm ci' },
  { file: 'npm-shrinkwrap.json', command: 'npm ci' },
  { file: 'yarn.lock', command: 'yarn install --frozen-lockfile' },
  { file: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { file: 'package.json', command: 'npm install' },
  { file: 'requirements.txt', command: 'pip install -r requirements.txt' },
  { file: 'Pipfile', command: 'pipenv install' },
  { file: 'Cargo.toml', command: 'cargo fetch' },
  { file: 'go.mod', command: 'go mod download' },
];

/**
 * `entries` is the repo root's directory listing. Returns the first matching
 * command in priority order (a lockfile beats its manifest — `npm ci` over
 * `npm install` when both `package-lock.json` and `package.json` are present),
 * or `null` when nothing recognizable is there — not every repo needs a
 * distinct install step, and an undetectable one is not itself a failure.
 */
export function detectBootstrapCommand(entries: readonly string[]): string | null {
  const present = new Set(entries);
  for (const check of CHECKS) {
    if (present.has(check.file)) return check.command;
  }
  return null;
}
