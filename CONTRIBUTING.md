# Contributing to Omadia

Thanks for considering a contribution. Issues, pull requests, and design
discussions are all welcome — please follow the conventions below so your
change can land quickly.

## Before you start

- For non-trivial changes, please open an issue first to discuss the
  approach. We'd rather catch a "this conflicts with the post-1.0 plugin
  marketplace" disagreement at issue-time than at PR-review-time.
- Read the [Code of Conduct](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
  applies to all interactions.
- Security issues do **not** belong in the public issue tracker. See
  [SECURITY.md](SECURITY.md) for the private channel.

## Contribution priority

Not every contribution gets the same review turnaround. Roughly highest to
lowest:

1. **Bug fixes**, especially regressions against a released version
2. **Security improvements** (coordinate sensitive ones privately first, see
   [SECURITY.md](SECURITY.md))
3. **Performance improvements** that ship with a before/after benchmark
4. **New features** that match the roadmap in the
   [README](README.md#status--roadmap)
5. **Documentation and examples**

This is a guide, not a gate. A well-scoped docs fix still lands faster than a
sprawling feature nobody asked for.

## Local development setup

Prerequisites:

- Node.js **22.12.x** (pinned via `middleware/.nvmrc` — `nvm use` picks
  it up automatically). Other Node versions break the `better-sqlite3`
  native ABI; the `preinstall` hook will refuse to proceed if you're on
  the wrong version.
- Docker + Docker Compose (for the local Postgres + optional service
  sidecars).
- An Anthropic API key for end-to-end testing of agent flows.

Bootstrap:

```bash
git clone https://github.com/byte5ai/omadia.git
cd omadia
cp infra/.env.example infra/.env             # set ANTHROPIC_API_KEY
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d postgres

# Middleware (Express + plugin runtime + builder)
cd middleware
nvm use
npm install
npm run dev                                  # starts on :3979

# Admin UI (Next.js 15)
cd ../web-ui
npm install
npm run dev                                  # starts on :3300
```

The middleware re-builds and re-types every workspace package on `npm run
dev`; the first cold start takes ~30 seconds, subsequent restarts are
incremental.

## Verification before pushing

> The repo ships a `.hooks/pre-push` guard that blocks direct pushes to
> `main`/`master`. `script/setup` activates it automatically (`git config
> core.hooksPath .hooks`); if you skipped the setup script, run that
> single command manually.

```bash
# In middleware/
npm run typecheck    # TypeScript --noEmit, runs across all workspaces
npm run lint         # ESLint flat-config + autofix; CI runs the same set
npm test             # Node test runner against the workspace test suite

# In web-ui/
npm run lint         # Next.js + react eslint config
npx tsc --noEmit     # TypeScript verification (no separate npm script)
```

CI runs the same verification on every pull request. Please ensure all
checks are green locally before opening a PR — it shortens the review cycle
for everyone.

## Pull request workflow

1. **Fork** `byte5ai/omadia`, create a topic branch off `main`.
2. **Commit messages** follow [Conventional
   Commits](https://www.conventionalcommits.org/):
   - `feat(scope): subject` for new functionality
   - `fix(scope): subject` for bug fixes
   - `refactor(scope): subject` for non-behavioural code changes
   - `docs(scope): subject`, `chore(scope): subject`, `ci(scope): subject`
   - `test(scope): subject`, `perf(scope): subject`
   - Body explains the **why**, not the **what** — the diff already
     explains the what.
   - **No `Co-Authored-By:` trailers for AI agents** (Claude, Codex,
     Copilot, etc.). Commits are made under the contributor's configured
     git identity, with no model-attribution footer.
3. **Pull request** — describe the change, link the issue if applicable,
   include manual-test notes for anything that touches a UI or a runtime
   path. Mark draft PRs early to invite feedback before the change is
   "done".
4. **Review** — at least one maintainer approval is required to merge. We
   aim to respond within 5 business days; if you don't hear back, ping
   the PR.
5. **Merge** — squash-merge is the default. The PR title becomes the
   commit subject; the PR description becomes the commit body.

## Code conventions

- **TypeScript strict mode** is non-negotiable. Use `unknown` over `any`,
  prefer discriminated unions over flag-based shapes, type all public
  exports explicitly.
- **ESLint flat config** lives at the repo root. Auto-fixable issues
  should be auto-fixed (`npm run lint`); fail-build issues should be
  resolved before pushing rather than disabled per-line.
- **Testing**: every new public function or API surface needs at least
  one test. Use the Node test runner (`node:test`) for middleware, Vitest
  is **not** a dependency in middleware (`web-ui` is on Vitest because
  Next.js).
- **Comments** explain non-obvious *intent* — what's surprising about this
  code, what trade-off was made, what alternative was considered and ruled
  out. Auto-generated boilerplate (param descriptions that just restate
  the type) is noise; please skip it.

## Security guidelines

The middleware runs plugin code and custodies operator secrets, so a few rules
are non-negotiable in any contribution:

- Never interpolate untrusted input into a shell command. Use argument arrays
  or `execFile`, never string concatenation into `exec`.
- Unwrap symlinks before any path operation on an operator-supplied path, so a
  crafted link cannot escape the directory it is meant to stay in.
- No `eval` or `new Function()` on untrusted content in plugin code.
- Validate cron strings before they reach the scheduler.

The patterns behind these rules live in
[`docs/security-architecture.md`](docs/security-architecture.md). Read it
before you touch the vault, the plugin loader, or any ingress channel.

### Dependency hardening

- **npm**: pin to a caret range (`^x.y.z`). Patch-level auto-updates are
  acceptable; open ranges (`*`, `latest`) and unpinned minors are not.
- **GitHub Actions**: pin third-party actions to a full commit SHA, not a
  moving tag. First-party `actions/*` may stay on a major tag.

## Plugin contributions

Channel and integration plugins generally belong in their own repositories
under maintainer ownership rather than the core `omadia` repo, to keep the
surface area focused. If you have an idea for a new plugin, please open a
discussion first — we'll point you at the plugin scaffolding and document
the integration points.
