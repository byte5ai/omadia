# Implementation plan — #336 minimal onboarding stack

Companion to `spec.md`. File-by-file changes, sequencing, and verification mapped to acceptance criteria. Phasing per spec §8: **P1 docs-truth → P2 minimal core → P3 prebuilt images.**

> **Branch:** `feat/336-minimal-onboarding-stack` (off `main`). Merge `origin/main` before PR.

---

## Repo facts this plan relies on (verified)

- Only `docker-compose.yaml` is git-tracked; `infra/` + `compose.yml` are gitignored (local-only).
- `docker-compose.yaml`: middleware + web-ui use `build:`; postgres/kroki/minio/ollama use `image:`. middleware `depends_on` `minio-init` + `ollama-init` (`service_completed_successfully`) + `kroki` (`service_started`) + `postgres` (`service_healthy`).
- middleware kernel degrades gracefully with no Ollama/MinIO/Kroki (no kernel change needed) — feature auto-install is gated on **env-var presence**.
- `middleware/.env.example` **pre-sets** `KROKI_BASE_URL`, `DIAGRAM_PUBLIC_BASE_URL`, `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID/SECRET`, `OLLAMA_BASE_URL`, `OLLAMA_EMBEDDING_MODEL` (localhost values). Compose currently overrides these with in-network DNS names via the middleware `environment:` block; it also loads `middleware/.env` via `env_file`.
- Existing CI: `.github/workflows/{ci.yml, build.yml, release.yml, auto-release.yml}`. web-ui has its own `web-ui/Dockerfile` (bakes `MIDDLEWARE_URL` build-arg).

⚠️ **Env-leak trap (must handle in P2):** if compose stops setting `KROKI_BASE_URL`/`AWS_*`/`OLLAMA_BASE_URL` on the minimal-core middleware but `middleware/.env` (copied from `.env.example`) still defines them, the `env_file` values leak into the container → middleware auto-installs diagrams/embeddings whose backends aren't running. **Fix:** comment out the feature vars in `.env.example` by default; each overlay file sets them explicitly.

---

## P1 — Docs truth (first in the single PR, per D5)

**Goal:** every README command works against the public repo. Fixes spec §1.2 + §1.3 honesty. Sequenced first so the tree stays self-consistent at each commit; since P2 lands in the same PR, the README here describes the **minimal-core** mechanism (override files) directly rather than the old build-from-source full stack. README copy MUST go through the **byte5-social-media** skill before writing (workspace hard-rule), in English (see [[prs-issues-always-english]]).

### T1.1 — `README.md` quickstart (~lines 40–76)
- Correct the "postgres, middleware, and the admin UI come up together" line and the implied 3-service reality vs the actual 9. State plainly what `up -d` does *today* (full stack, builds from source) — or, if P2 lands in the same PR, describe the minimal core.
- Remove/soften the "60-second" promise pending the AC8 measurement (Q4). If P1 ships before P3, do **not** claim seconds while still building from source.

### T1.2 — `README.md` §"Optional Compose profiles" (~lines 150–166)
- Delete the three `docker compose -f infra/docker-compose.yml --profile …` commands (broken — no `infra/`).
- Replace with the **Option A** override-file commands (see P2 T2.x). If P2 isn't in this PR yet, document the *current* truth: "diagrams/embeddings start by default; there is not yet a minimal path" — do not document a mechanism that doesn't exist (that is the exact bug being fixed).

### T1.3 — opportunistic doc corrections
- Fix the stale "fail-fast at boot if `ANTHROPIC_API_KEY` is unset" comment in `docker-compose.yaml` (kernel boots; chat route 503s until key saved).

**Verify P1:** execute every `docker …`/command block in the README verbatim on a fresh clone → all succeed (AC6, partial).

---

## P2 — Minimal core via override files (Option A)

**Goal:** AC1–AC5, AC9. Still builds from source (no images yet) — that's fine; P2 proves the split, P3 makes it fast.

### T2.1 — `docker-compose.yaml` → minimal core only
- Keep `middleware`, `web-ui`, `postgres`. **Remove** `kroki`, `kroki-mermaid`, `minio`, `minio-init`, `ollama`, `ollama-init` (move to overlays).
- On `middleware`: **remove** `depends_on: minio-init`, `ollama-init`, `kroki`. Keep `postgres: service_healthy`.
- On `middleware`: **remove** the feature env (`KROKI_BASE_URL`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID/SECRET`, `BUCKET_NAME`, `DIAGRAM_*`, `OLLAMA_*`). Keep in-network wiring that is core (`DATABASE_URL`, `PLATFORM_DATA_DIR`, `VAULT_KEY` dev fallback, `NODE_ENV`).
- Keep only `middleware-data` + `postgres-data` volumes here; overlays declare `minio-data`/`ollama-data`.

### T2.2 — `docker-compose.storage.yaml` (object storage / attachments)
- Adds `minio` + `minio-init` (verbatim from current file) and `minio-data` volume.
- Adds to `middleware.environment`: `AWS_ENDPOINT_URL_S3=http://minio:9000`, `AWS_ACCESS_KEY_ID/SECRET=minioadmin`, `BUCKET_NAME=diagrams`.
- (Compose merge is additive; re-declaring `middleware` with only an `environment` block merges into the core definition.)

### T2.3 — `docker-compose.diagrams.yaml` (Kroki rendering)
- Adds `kroki` (`platform: linux/amd64` note preserved) + `kroki-mermaid`.
- Adds to `middleware.environment`: `KROKI_BASE_URL=http://kroki:8000`, `DIAGRAM_PUBLIC_BASE_URL=http://localhost:8080`, and `DIAGRAM_URL_SECRET` (from `.env`, not hardcoded).
- Document: diagrams requires storage → run with both `-f storage -f diagrams`. To make it foolproof, this overlay MAY also declare `minio`/`minio-init` (additive merge is safe).

### T2.4 — `docker-compose.embeddings.yaml` (Ollama)
- Adds `ollama` + `ollama-init` + `ollama-data` volume.
- Adds to `middleware.environment`: `OLLAMA_BASE_URL=http://ollama:11434`, `OLLAMA_EMBEDDING_MODEL=nomic-embed-text`.

### T2.5 — `docker-compose.build.yaml` (contributor build)
- Re-adds `build:` to `middleware` (`context: .`) and `web-ui` (`context: ./web-ui`, build-arg `MIDDLEWARE_URL`). Overrides the `image:` from the core file (P3) so `up --build` compiles from source.

### T2.6 — `middleware/.env.example` audit (the env-leak fix)
- Comment out (or move behind clearly-labeled "only if you enable the overlay" headers) `KROKI_BASE_URL`, `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID/SECRET`, `OLLAMA_BASE_URL`, `OLLAMA_EMBEDDING_MODEL` so a default `.env` does **not** auto-enable features in minimal core. Keep `ANTHROPIC_API_KEY` + `DIAGRAM_URL_SECRET` (the latter empty, generated only when enabling diagrams).

**Verify P2:**
- AC1/AC2/AC9: clean clone, set key, `docker compose up -d` → exactly 3 containers, no model pull, UI at :3333, middleware logs show no diagram/embeddings/storage plugin, no crash.
- AC3: `-f docker-compose.yaml -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml up -d` → diagrams render end-to-end.
- AC4: add `-f docker-compose.embeddings.yaml` → embeddings enabled (KG stops logging "embeddings disabled").
- AC5: `-f docker-compose.yaml -f docker-compose.build.yaml up -d --build` → builds from source, functionally identical.
- Use the **Interceptor** skill to confirm the admin UI renders at `http://localhost:3333` (mandatory visual verification, per project rules).

---

## P3 — Prebuilt multi-arch images (GHCR)

**Goal:** AC7, AC8, G1. Flip the default path from build → pull.

### T3.1 — publish workflow
- Add image build+push to the **existing release flow** (extend `release.yml` / `auto-release.yml`) rather than a standalone workflow, unless a separate `publish-images.yml` is cleaner. Use `docker/setup-qemu-action` + `docker/setup-buildx-action` + `docker/build-push-action` with `platforms: linux/amd64,linux/arm64`.
- Targets: `ghcr.io/byte5ai/omadia-middleware` (context `.`, `Dockerfile`) and `ghcr.io/byte5ai/omadia-web-ui` (context `web-ui`, `web-ui/Dockerfile`, build-arg `MIDDLEWARE_URL=http://middleware:8080`).
- Auth: `permissions: packages: write`, `GITHUB_TOKEN` login to `ghcr.io`.
- Tags (**D1**): `X.Y.Z` + `X.Y` + `latest` on GitHub Release; `edge` + `sha-<short>` on every push to `main`. Set `org.opencontainers.image.{source,revision,version,licenses}` labels.
- After first publish: mark both GHCR packages **public**.

### T3.2 — flip `docker-compose.yaml` to pull
- `middleware.image: ghcr.io/byte5ai/omadia-middleware:${OMADIA_VERSION:-<tag>}`, drop `build:` from the core file (now lives only in `docker-compose.build.yaml`).
- Same for `web-ui`.
- `middleware.image: ghcr.io/byte5ai/omadia-middleware:${OMADIA_VERSION:-latest}` (**D1** — default `latest` = newest release, overridable). Document `OMADIA_VERSION` in `.env.example` / README.

### T3.3 — README quickstart finalization
- Document the pull-based `docker compose up -d`, the `OMADIA_VERSION` pin, and the contributor build command.
- Measure cold pull-to-UI on a reference connection; set the timing claim to the measured value (**D3** — keep "60-second" only if the measurement supports it, else soften).

**Verify P3:**
- AC7: from a machine with no cache, `docker pull ghcr.io/byte5ai/omadia-middleware:<tag>` (and web-ui) succeeds without auth; `docker buildx imagetools inspect` shows both arches.
- AC8: time `docker compose up -d` cold → UI reachable; record the figure; update README + this plan.

---

## Cross-cutting

- **Tests/CI:** no kernel code changes expected, so unit suites unaffected. Add (optional) a CI job that runs `docker compose config` on each overlay combination to catch merge/typo regressions, and a minimal-core smoke (`up -d` → curl `:8080/healthz` + `:3333`).
- **Docs beyond README:** check `docs/` and `CONTRIBUTING.md` for stale compose/profile references; update if found.
- **Memory/handoff:** on completion, record a project-memory entry + `MEMORY.md` pointer (delivery overview) per workspace rules.

## Task checklist (single PR per D5)
- [x] Resolve open questions → locked as D1–D5 (spec §7)
- [x] P1: README quickstart + "Optional features" rewrite (via byte5-social-media skill, anti-AI self-review passed); compose ANTHROPIC comment fixed
- [x] P2: core compose; storage/diagrams/embeddings/build overlays; `.env.example` audit
- [x] P2 verify: built core from source + booted on remapped ports → 3 containers, middleware healthy, graceful degradation in logs, no crash, /health 200; storage overlay also booted end-to-end (minio healthy → minio-init exit 0 → middleware healthy, tigris ENABLED). All compose merge combos pass `docker compose config`.
- [x] P3: GHCR multi-arch publish activated in release.yml (edge on main, semver+latest on release — D1; publishes both `v`-prefixed and bare tags); compose pulls `${OMADIA_VERSION:-latest}`; README timing left per D3 (softened to honest "Quickstart" — no live AC8 measurement possible pre-publish)
- [ ] P3 verify: AC7 (multi-arch GHCR pull) + AC8 (cold pull-to-UI timing) — **CI/post-merge only** (images don't exist until the workflow runs on a release)
- [x] Dual review round 1: /code-review (high) — 2 findings fixed (v-prefix tag, :latest bootstrap note); Forge/Codex — sole BLOCKER (minio mc healthcheck) empirically REFUTED (image bundles mc, chain boots), NIT (embeddings needs network) addressed
- [x] Dual review round 2 (on converged state): /code-review — `OMADIA_VERSION` pin docs wrongly named middleware/.env (compose interpolation reads only shell/root `.env`) → fixed in compose header + README; Forge — v-prefix fix validated correct, SHOULD-FIX (hand-rolled `:latest` could re-point to older release) → switched to `flavor: latest=auto`, NIT (header comment) → fixed. YAML re-validated, compose configs green.
- [ ] Merge `origin/main`; open ONE PR (docs+compose+CI), link #336 — **awaiting user**

## Verification evidence (2026-06-19)
- Minimal core (`-f docker-compose.yaml -f docker-compose.build.yaml`): exactly `middleware`(healthy) + `postgres`(healthy) + `web-ui`; logs: diagrams/office "skipping auto-install", "tigris attachment store DISABLED", "embeddings disabled", "chat DISABLED … Admin UI + all other endpoints are up"; no fatal/ECONNREFUSED; `/health`→200, web-ui→302. = AC1/AC2/AC9 PASS.
- Storage overlay (`+ -f docker-compose.storage.yaml`): `minio` healthy in ~6s (`mc ready local` → "cluster 'local' is ready", exit 0), `minio-init` Exited(0) "diagrams bucket ready", `middleware` Healthy, tigris store ENABLED (no DISABLED line). = AC3 (storage half) PASS; refutes the Forge minio-deadlock BLOCKER.
- `docker compose config` valid for core, full (9 svc), and build combos.
- AC7/AC8 (pulled multi-arch images + cold-pull timing) only verifiable in CI after the first release publishes images.
