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
cp middleware/.env.example middleware/.env   # set ANTHROPIC_API_KEY
docker compose up -d minio kroki ollama      # sidecars (skip middleware/web-ui — those run via npm)

# Middleware (Express + plugin runtime + builder)
cd middleware
nvm use
npm install
npm run dev                                  # starts on :8080

# Admin UI (Next.js 15)
cd ../web-ui
npm install
npm run dev                                  # starts on :3000
```

The middleware re-builds and re-types every workspace package on `npm run
dev`; the first cold start takes ~30 seconds, subsequent restarts are
incremental.

## Verification before pushing

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

## Plugin contributions

Channel and integration plugins generally belong in their own repositories
under maintainer ownership rather than the core `omadia` repo, to keep the
surface area focused. If you have an idea for a new plugin, please open a
discussion first — we'll point you at the plugin scaffolding and document
the integration points.
