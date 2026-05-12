# syntax=docker/dockerfile:1.7
#
# Repo-root Dockerfile. Build context is the repo root so we can bundle the
# middleware TypeScript app under `middleware/` together with its runtime
# assets (plugin manifests, builder boilerplate, entity registry).

# --- builder ----------------------------------------------------------------
# Debian-slim instead of alpine because some transitive dependencies of
# botbuilder (@azure/msal-node family) have post-install hooks that break on
# Alpine's musl libc without extra build tools. Slim keeps the image small
# while staying on glibc.
FROM node:22.12.0-slim AS builder
ARG TARGETARCH
WORKDIR /app

# Install ALL deps (incl. dev) so tsc can run. Workspace packages must be
# present BEFORE `npm ci` so the `workspaces: ["packages/*"]` entries in
# package.json resolve — otherwise the @omadia/* symlinks in node_modules
# would be missing and imports break at build/runtime.
COPY middleware/package.json middleware/package-lock.json ./
COPY middleware/packages ./packages
# preinstall hook from package.json requires this file; copy it BEFORE
# `npm ci` so the hook can resolve. Full `scripts/` overlay follows after.
COPY middleware/scripts/check-node-version.mjs ./scripts/check-node-version.mjs
# sharp ships pre-built native binaries per CPU arch. The `npm ci` above
# already pulls the right one when the host arch matches the target — for
# cross-platform builds (e.g. Apple Silicon building a linux-amd64 image)
# we re-install with the explicit --os/--cpu flags so the correct binary
# lands. arm64 / x64 covers every realistic container host today. Docker's
# TARGETARCH uses `amd64`; npm's `--cpu` uses `x64` — translate once here.
RUN NPM_CPU=$(case "${TARGETARCH:-amd64}" in arm64) echo arm64;; *) echo x64;; esac) \
 && npm ci --no-audit --no-fund \
 && npm install --no-save --include=optional --os=linux --cpu="${NPM_CPU}" sharp

COPY middleware/tsconfig.json ./
COPY middleware/src ./src
COPY middleware/scripts ./scripts
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22.12.0-slim AS runtime
ARG TARGETARCH
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
# Optional skills directory. Per-domain SKILL.md bundles ship here when a
# deployment carries domain-specific runtime prompts. Empty by default.
ENV SKILLS_DIR=/app/skills
# Plugin manifests are bundled at a fixed path; without this the loader's
# REPO_ROOT heuristic resolves to `/` (see manifestLoader.ts for the why).
ENV PLUGIN_MANIFEST_DIR=/app/plugin-manifests

# `gosu` lets the entrypoint drop from root to the `node` user after the volume
# chown step. ~2 MB, single static binary.
# `zip` is required by the boilerplate's scripts/build-zip.mjs which the
# Builder pipeline spawns to package generated agents.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu zip \
 && rm -rf /var/lib/apt/lists/*

COPY middleware/package.json middleware/package-lock.json ./
# S+11+ workspace packages: pull from the builder stage (with compiled dist/ per
# package). Must be in place BEFORE `npm ci --omit=dev` so npm can
# create the @omadia/* plugin symlinks in node_modules (at runtime,
# the compiled imports `@omadia/orchestrator` etc. resolve directly
# through those symlinks). Per-package source/.ts files are harmlessly
# copied along (image size ~MB-range, no security concern since internal).
COPY --from=builder /app/packages ./packages
# preinstall hook from package.json requires this file (Node-version guard).
COPY middleware/scripts/check-node-version.mjs ./scripts/check-node-version.mjs
RUN NPM_CPU=$(case "${TARGETARCH:-amd64}" in arm64) echo arm64;; *) echo x64;; esac) \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm install --no-save --include=optional --os=linux --cpu="${NPM_CPU}" sharp \
 && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Non-TS prompt assets — tsc skips .md, so copy them next to the compiled
# loader (BUILDER_PROMPT_PATH expects them in dist/plugins/builder/prompts).
COPY middleware/src/plugins/builder/prompts ./dist/plugins/builder/prompts
# Routines migrations — tsc skips .sql, so copy them next to the compiled
# migrator (runRoutineMigrations resolves the dir relative to its own URL).
COPY middleware/src/plugins/routines/migrations ./dist/plugins/routines/migrations
# Auth migrations (OB-49a) — same reason as routines: tsc doesn't bundle
# .sql, so the runtime needs them copied next to the compiled migrator.
COPY middleware/src/auth/migrations ./dist/auth/migrations
# Profile-storage migrations — runProfileStorageMigrations scans this dir
# at boot; tsc skips .sql so the .sql files need explicit COPY.
COPY middleware/src/profileStorage/migrations ./dist/profileStorage/migrations
# Profile-snapshots migrations — same pattern (palaia-phase profile snapshots).
COPY middleware/src/profileSnapshots/migrations ./dist/profileSnapshots/migrations
# Graph services migrations — same pattern (KG schema bootstrap helpers).
# Graph migrations now live inside the @omadia/knowledge-graph-neon plugin
# package (consolidated into a single ordered series). The plugin's
# copy-sql-assets.mjs build step puts them under dist/migrations/, which is
# bundled via the `COPY --from=builder /app/packages` step above.
# Seed files are bundled with the image so a fresh volume gets primed on first boot.
COPY middleware/seed ./seed
# Plugin manifests directory. The loader reads `<plugin-id>.manifest.yaml`
# files here at boot to register external plugins without going through the
# ZIP upload flow. Empty by default (ships with a README only).
COPY middleware/plugin-manifests ./plugin-manifests
# Bootstrap profiles — profileLoader.ts reads the curated plugin stacks
# (production / minimal-dev / blank) here. Without this path the onboarding
# modal cannot offer profile templates.
COPY middleware/profiles ./profiles
ENV PROFILES_DIR=/app/profiles
# Plugin-Builder boilerplate — boilerplateSource.ts reads the template files
# for the codegen engine here. Whole-tree COPY so both templates
# (agent-integration, agent-pure-llm) land in the image; BUILDER_BOILERPLATE_DIR
# points at the root, individual templates are resolved via templateId.
COPY middleware/assets/boilerplate ./boilerplate
ENV BUILDER_BOILERPLATE_DIR=/app/boilerplate
# Entity-Registry (Builder vocabulary) — entityVocabulary.ts reads this yaml
# at boot. Without the env var the dist-relative walk would target a docs/
# path that doesn't ship in the public release.
COPY middleware/assets/entity-registry.v1.yaml ./entity-registry.v1.yaml
ENV BUILDER_ENTITY_REGISTRY_PATH=/app/entity-registry.v1.yaml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Prepare /data so the first boot without a mounted volume also works.
# Also create an empty /app/skills so SKILLS_DIR points at an existing dir
# even when the deployment ships no domain skill bundles.
RUN mkdir -p /data/memory /app/skills && chown -R node:node /data /app

EXPOSE 8080

# Entrypoint runs as root so it can chown the Fly volume (mounted as root:root by
# default), then drops to the `node` user via gosu.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
