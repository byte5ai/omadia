# Spec — Minimal onboarding stack: prebuilt images, real opt-in profiles, honest docs

- **Issue:** [#336](https://github.com/byte5ai/omadia/issues/336) — _Default compose stack is heavier than documented + two docs/compose contradictions_
- **Type:** bug (docs) + enhancement (onboarding architecture)
- **Status:** Implemented + locally verified on branch `worktree-spec-336-minimal-onboarding` (see plan.md "Verification evidence"); dual-reviewed (/code-review + Forge/Codex). Awaiting `origin/main` merge + PR. AC7/AC8 (pulled images, cold-pull timing) complete in CI post-release only.
- **Author:** Marcel Wege

---

## 1. Problem

`docker compose up -d` is sold as a "60-second quickstart," but on a cold clone it is a multi-minute, heavyweight first boot, and the documented "lighter" path does not exist. Three concrete, verified defects:

### 1.1 The default stack builds from source and starts 9 services
The tracked `docker-compose.yaml` brings up **9 services** unconditionally:

| Service | Source | Role |
|---|---|---|
| `middleware` | **`build:` (`.` + Dockerfile)** | kernel API (`:8080`) |
| `web-ui` | **`build:` (`./web-ui`)** | admin UI (`:3333`) |
| `postgres` | `image: pgvector/pgvector:pg17` | KG / routines / verifier store |
| `kroki` | `image: yuzutech/kroki:0.29.1` | diagram gateway |
| `kroki-mermaid` | `image: yuzutech/kroki-mermaid:0.29.1` | Mermaid companion |
| `minio` | `image: minio/minio:…` | S3-compatible object storage |
| `minio-init` | `image: minio/mc:latest` | one-shot bucket provisioning |
| `ollama` | `image: ollama/ollama:latest` | in-tenant embeddings |
| `ollama-init` | `image: ollama/ollama:latest` | one-shot pull of `nomic-embed-text` (~270 MB) |

Because `middleware` and `web-ui` use `build:` (no published `image:`), a fresh clone runs a full `npm ci` + `tsc` + Next.js build on first `up`. `ollama-init` then pulls ~270 MB. First boot is minutes, not seconds.

### 1.2 README references a non-existent path
README §"Optional Compose profiles" (lines ~150–161) documents:
```
docker compose -f infra/docker-compose.yml --profile diagrams up -d
docker compose -f infra/docker-compose.yml --profile embeddings up -d
```
There is **no `infra/` directory in the public repo** (it is gitignored / local-only). These commands fail as written. _(Confirmed: `git ls-files` tracks only `docker-compose.yaml`; `infra/` and `compose.yml` are git-ignored.)_

### 1.3 "Optional" features are actually on by default
The README frames diagrams and embeddings as opt-in profiles. The root `docker-compose.yaml` has **no `profiles:` keys at all** — `kroki`, `kroki-mermaid`, `minio`, and `ollama` start unconditionally. The middleware service even hard-wires the dependency:
```yaml
depends_on:
  minio-init:  { condition: service_completed_successfully }
  ollama-init: { condition: service_completed_successfully }
  kroki:       { condition: service_started }
```
So `up -d` blocks on the MinIO bucket provisioning **and** the 270 MB model pull before the kernel even starts. There is no "minimal core" (middleware + web-ui + postgres) path.

### 1.4 Why it matters
The barrier to *trying* omadia is not "you need Docker" — even with Docker, the first-run footprint and build time are high, and the documented lighter path is broken. This is the first impression for every new self-hoster.

---

## 2. Key finding that shapes the solution

**The middleware kernel already degrades gracefully without Ollama, MinIO, and Kroki — no kernel code changes are required to run a minimal core.** Each subsystem is a built-in plugin that is conditionally auto-installed and consumed via late-resolved, `undefined`-tolerant services:

| Subsystem | Gating env | Behavior when env absent |
|---|---|---|
| Embeddings (Ollama) | `OLLAMA_BASE_URL` | embedding client never published; KG runs "embeddings disabled" → FTS-only retrieval, no topic detection. No boot connect. |
| Object storage (S3/MinIO) | `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `tigrisStore` not published; attachment reader inert (clean error), diagram/office tools not registered. No boot connect. |
| Diagrams (Kroki) | `KROKI_BASE_URL` (+ S3 + `DIAGRAM_URL_SECRET` + `DIAGRAM_PUBLIC_BASE_URL`) | diagrams plugin auto-install skipped; `render_diagram` tool not registered. No boot connect. |

Sources: `middleware/src/plugins/bootstrap.ts` (484–532, 990–1039, 1068–1080), `middleware/src/index.ts` (1291–1315, 1500–1522), `harness-embeddings/src/plugin.ts` (97–107), `harness-knowledge-graph-neon/src/plugin.ts` (134, 163–168), `harness-orchestrator/src/attachmentReaderFactory.ts`, `harness-diagrams/src/plugin.ts` (50–65).

**Two consequences for this spec:**
1. The minimal core is a **compose + CI + docs** change, not a kernel rewrite. The only things forcing the sidecars up today are (a) the `depends_on` block on `middleware` and (b) the always-set feature env vars on `middleware`.
2. **Feature auto-install is gated on env-var *presence***, not on the sidecar being reachable. Therefore the feature env vars (`KROKI_BASE_URL`, `AWS_*`, `OLLAMA_BASE_URL`, …) **must be absent in the minimal core** — otherwise the middleware auto-installs a plugin whose backend isn't running and fails only at call time. This is the decisive constraint on the compose design (see §5).

**Two nuances to fold in (not in the original issue):**
- Object storage is **not diagram-only** — it also powers chat **attachment ingestion** and the **office** document plugin. So the opt-in unit is "object storage / attachments," with diagrams layered on top. `PLATFORM_DATA_DIR=/data` (vault, `installed.json`, builder `drafts.db`, uploaded plugin packages) is a local volume, **independent of S3** — minimal core keeps all of it.
- The compose comment claiming the middleware "fail[s] fast at boot if `ANTHROPIC_API_KEY` is unset" is **stale**: the kernel boots, the admin UI + setup wizard come up, and the chat route returns 503 until a key is saved. Worth correcting opportunistically.

---

## 3. Goals & non-goals

### Goals
- **G1** — `docker compose up -d` on a cold clone reaches a usable admin UI by **pulling prebuilt images** (no source build) and starting a **minimal core** (`middleware` + `web-ui` + `postgres`).
- **G2** — Diagrams, embeddings, and object-storage/attachments are **genuinely opt-in** and off by default, via a documented, working mechanism in the **single tracked repo** (no `infra/` file required).
- **G3** — Every command in the README works exactly as written against the public repo.
- **G4** — Contributors can still build from source with one documented command.
- **G5** — Quickstart timing claim is honest and reproducible.

### Non-goals
- Kubernetes / Helm, multi-host, or production HA topology.
- Changing kernel feature-gating logic (already graceful — confirmed §2).
- Replacing Ollama with a hosted embeddings provider (separate concern).
- Touching the gitignored local `infra/` / `compose.yml` (deployment-only, out of public scope).
- Shrinking image size / build-time optimization beyond "pull instead of build."

---

## 4. Requirements

### Functional
- **R1** Prebuilt, multi-arch (`linux/amd64` + `linux/arm64`) images for `middleware` and `web-ui` published to GHCR under the `byte5ai` org, pullable anonymously (public packages).
- **R2** `docker-compose.yaml` references those images by tag and pulls them by default; **no `build:` on the default path**.
- **R3** A minimal core of exactly `middleware` + `web-ui` + `postgres` starts on `docker compose up -d`; no `kroki*`, `minio*`, or `ollama*` containers start, and the middleware does **not** block on `*-init` completion.
- **R4** An opt-in mechanism brings up object-storage/attachments, diagrams, and embeddings — each independently — and **sets the corresponding feature env on `middleware`** so the plugin actually activates.
- **R5** A documented one-command path for contributors to build from source instead of pulling.
- **R6** README quickstart + profiles sections rewritten to match R1–R5 exactly; the broken `infra/docker-compose.yml` commands removed.

### Non-functional
- **R7** Default cold-start (warm Docker layer cache absent, typical broadband) is dominated by image pull, not compilation; target a defensible documented figure (see §7, A4).
- **R8** Images are reproducible/traceable: tagged with semver on release and `edge` + commit SHA on `main`; provenance/labels (`org.opencontainers.image.*`) set.
- **R9** No secret material in published images; `VAULT_KEY` dev-fallback behavior unchanged for local use.
- **R10** Existing data volumes (`middleware-data`, `postgres-data`, `minio-data`, `ollama-data`) and loopback-only port bindings are preserved.

---

## 5. Design decision: how to express "minimal core + opt-in" in compose

The hard constraint (§2.2): **enabling a feature must add the sidecar service *and* set feature env on the always-on `middleware` service.** Docker Compose `profiles:` can gate whether a *service* starts, but cannot conditionally set env vars on a *different* (always-on) service. This rules out a naive single-file `--profile` design and is exactly the trap the current/old docs fell into.

### Option A — Override files (RECOMMENDED)
- `docker-compose.yaml` = minimal core only (middleware, web-ui, postgres). Middleware carries **no** diagram/storage/embedding env.
- `docker-compose.storage.yaml` = adds `minio` + `minio-init`; sets `AWS_*` + `BUCKET_NAME` on middleware (enables attachments + is a prerequisite for diagrams/office).
- `docker-compose.diagrams.yaml` = adds `kroki` + `kroki-mermaid`; sets `KROKI_BASE_URL` + `DIAGRAM_URL_SECRET` + `DIAGRAM_PUBLIC_BASE_URL` on middleware. Documented to compose **with** `storage`.
- `docker-compose.embeddings.yaml` = adds `ollama` + `ollama-init`; sets `OLLAMA_BASE_URL` on middleware.
- `docker-compose.build.yaml` = re-adds `build:` to middleware + web-ui for contributors.

Usage:
```bash
docker compose up -d                                              # minimal core (pulls)
docker compose -f docker-compose.yaml \
  -f docker-compose.storage.yaml -f docker-compose.diagrams.yaml \
  -f docker-compose.embeddings.yaml up -d                         # full stack
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build  # contributors
```

**Pros:** the only mechanism that correctly couples "start sidecar" with "set env on middleware"; each overlay is self-contained and additive; works in the single tracked repo; honest and copy-pasteable. **Cons:** verbose multi-`-f` invocation; the layering convention must be documented (diagrams ⇒ also storage).

### Option B — Single file with `profiles:` + `.env` toggles (REJECTED)
Sidecars get `profiles: [diagrams|embeddings|storage]`; feature env on middleware uses `${KROKI_BASE_URL:-}` and the operator uncomments vars in `.env` before `--profile … up`. **Rejected:** two coupled manual steps (activate profile *and* edit `.env`); forgetting the env means the sidecar starts but the feature stays off (or vice-versa: env set, sidecar absent → auto-install + runtime failure). This re-creates the original confusion.

### Option C — Profiles + always-set env + reachability gating (REJECTED for v1)
Single file, profiles for sidecars, feature env always pointing at in-network DNS names; change the kernel to gate auto-install on *reachability* instead of env presence. **Rejected for v1:** requires kernel code changes (contradicts the "no code change" finding and widens blast radius). Could be a future enhancement to enable clean `--profile` ergonomics.

> **Decision:** Adopt **Option A**. It is the only option that honors the env-coupling constraint without kernel changes, and it keeps every documented command working against the single public repo. A thin convenience wrapper (`make up-full` / a short `scripts/` helper) MAY be added to hide the multi-`-f` verbosity (see §7, A3).

---

## 6. Acceptance criteria

- **AC1** On a clean machine with no omadia images cached, `git clone … && cp middleware/.env.example middleware/.env && (set ANTHROPIC_API_KEY) && docker compose up -d` results in exactly three running containers (`middleware`, `web-ui`, `postgres`) with **no image build step**, and `http://localhost:3333` serves the admin UI.
- **AC2** `docker compose ps` after AC1 lists **no** `kroki`, `kroki-mermaid`, `minio`, `minio-init`, `ollama`, or `ollama-init` container, and `docker compose up` does not pull `nomic-embed-text`.
- **AC3** Adding `-f docker-compose.storage.yaml -f docker-compose.diagrams.yaml` starts MinIO + Kroki, the middleware logs show the diagrams plugin auto-installed, and `render_diagram` works end-to-end (diagram renders and is fetched from the published host URL).
- **AC4** Adding `-f docker-compose.embeddings.yaml` starts Ollama, pulls the model once, and middleware logs show embeddings enabled (KG no longer logs "embeddings disabled").
- **AC5** The contributor build command (`-f docker-compose.build.yaml … up -d --build`) builds both images from source and the stack is functionally identical to the pulled one.
- **AC6** Every `docker …` command block in `README.md` is executed verbatim against a fresh public clone and succeeds; no command references `infra/`.
- **AC7** Published GHCR packages `omadia-middleware` and `omadia-web-ui` exist, are public, expose `linux/amd64` + `linux/arm64`, and pulling the README-pinned tag succeeds without auth.
- **AC8** README quickstart timing claim is reproduced and documented (measured cold pull-to-UI on a reference connection); per **D3**, the "60-second" wording is retained only if the measurement supports it, else softened to match the measured figure.
- **AC9** Minimal-core middleware boots cleanly with **no** `AWS_*`/`KROKI_*`/`OLLAMA_*` env set: no crash, no stack traces; chat works once the key is set; attachment/diagram tools are simply absent.

---

## 7. Resolved decisions (locked with Marcel, 2026-06-19)

- **D1 (image tags & cadence)** — Publish `edge` + `sha-<short>` on every push to `main`; `X.Y.Z` + `X.Y` + `latest` on GitHub Release. `docker-compose.yaml` defaults to `image: …:${OMADIA_VERSION:-latest}` (newest release), overridable via `OMADIA_VERSION`. Frictionless for the pull-audience; advanced users pin a version.
- **D2 (web-ui baked `MIDDLEWARE_URL`)** — Accepted. The web-ui image bakes `MIDDLEWARE_URL=http://middleware:8080` at **build time** (Next.js rewrite target, not a runtime var); correct for the default compose topology. Self-hosters with a different topology rebuild via `docker-compose.build.yaml`. Add a one-line README note; no further action.
- **D3 ("60-second" wording)** — **Conditional:** keep the "60-second" badge/anchor **only if** the AC8 cold pull-to-UI measurement actually lands near 60s; otherwise soften to "Quickstart / ~1–2 min first pull." Wording is set after measurement, not before.
- **D4 (convenience wrapper)** — None. Keep transparent raw `docker compose -f … ` commands in the README; no Makefile/scripts layer.
- **D5 (PR scope)** — **One PR** covering P1 + P2 + P3 (docs + compose split + GHCR images). The phases in §8 are sequencing within that single PR, not separate PRs.

---

## 8. Suggested phasing

- **P1 — Docs truth (fast, no infra):** rewrite README §quickstart + §profiles to describe a mechanism that *works today* (Option A override files, building from source for now), delete the `infra/` commands, correct the "come up together" / ANTHROPIC fail-fast wording. Ships immediately, fixes 1.2 + 1.3 honesty.
- **P2 — Minimal core (compose):** split `docker-compose.yaml` into core + overlays per §5; remove the `depends_on` on `*-init`; verify AC1–AC5, AC9. No CI needed yet (still builds).
- **P3 — Prebuilt images (CI):** add the GHCR multi-arch publish workflow; flip `docker-compose.yaml` to `image:` pull; add `docker-compose.build.yaml`; verify AC7, AC8. This is what finally makes the quickstart fast.

**Per D5, all three phases ship in ONE PR** — the ordering above is the implementation sequence within that PR (docs-truth first so the tree is always self-consistent, then the compose split, then the CI/images flip), not separate PRs.

---

## 9. Risks

- **Multi-arch build cost/time** in CI (QEMU emulation for the off-native arch is slow). Mitigate with layer caching / native arm runners if available.
- **`:latest` drift** — if compose floats `:latest`, a contributor's pulled stack may not match their source checkout. Mitigated by Q1 pinning decision.
- **Overlay layering mistakes** — enabling `diagrams` without `storage` yields a half-configured diagrams plugin (env set, no bucket). Mitigate by documenting the dependency clearly and/or having `diagrams.yaml` also define the minio service (compose merge is additive, so listing it in both overlays is safe).
- **Stale env in `middleware/.env.example`** — must not pre-set `KROKI_BASE_URL`/`AWS_*`/`OLLAMA_BASE_URL`, or minimal core silently auto-installs broken features. Audit `.env.example` as part of P2.
