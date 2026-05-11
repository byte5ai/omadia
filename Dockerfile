# syntax=docker/dockerfile:1.7
#
# Repo-root Dockerfile. Build context is the repo root so we can bundle both
# the middleware TypeScript app under `middleware/` AND the `skills/` tree
# that each sub-agent loads at runtime via SKILLS_DIR.

# --- builder ----------------------------------------------------------------
# Debian-slim instead of alpine because some transitive dependencies of
# botbuilder (@azure/msal-node family) have post-install hooks that break on
# Alpine's musl libc without extra build tools. Slim keeps the image small
# while staying on glibc.
FROM node:26.1.0-slim AS builder
WORKDIR /app

# Install ALL deps (incl. dev) so tsc can run. Workspace-Pakete (S+11+)
# müssen VOR `npm ci` im Build-Context sein, sonst kann npm die
# `workspaces: ["packages/*"]`-Einträge in package.json nicht resolven —
# folge wäre, dass die @omadia/* Plugin-Symlinks in node_modules
# fehlen + Imports zur Build/Runtime kaputt gehen.
COPY middleware/package.json middleware/package-lock.json ./
COPY middleware/packages ./packages
# preinstall hook from package.json requires this file; copy it BEFORE
# `npm ci` so the hook can resolve. Full `scripts/` overlay follows after.
COPY middleware/scripts/check-node-version.mjs ./scripts/check-node-version.mjs
RUN npm ci --no-audit --no-fund \
 && npm install --no-save --include=optional --os=linux --cpu=x64 sharp

COPY middleware/tsconfig.json ./
COPY middleware/src ./src
COPY middleware/scripts ./scripts
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM node:26.1.0-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
# Bundled skills live inside the image; each sub-agent's SKILL.md is loaded
# at boot via SKILLS_DIR. Must match the runtime path of the COPY below.
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
# S+11+ Workspace-Pakete: vom builder-Stage holen (mit compiled dist/ pro
# package). Müssen VOR `npm ci --omit=dev` da sein, damit npm die
# @omadia/* Plugin-Symlinks in node_modules anlegen kann (zur
# Runtime resolven die compiled imports `@omadia/orchestrator` usw.
# direkt durch diese Symlinks). Pro-Package source/.ts-Files sind harmlos
# mitkopiert (Image-Größe ~MB-Bereich, kein Sicherheitsthema da intern).
COPY --from=builder /app/packages ./packages
# preinstall hook from package.json requires this file (Node-version guard).
COPY middleware/scripts/check-node-version.mjs ./scripts/check-node-version.mjs
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm install --no-save --include=optional --os=linux --cpu=x64 sharp \
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
COPY middleware/src/services/graph/migrations ./dist/services/graph/migrations
# Seed files are bundled with the image so a fresh volume gets primed on first boot.
COPY middleware/seed ./seed
# Sub-agent skill bundles (SKILL.md + optional assets). Zip artefacts from the
# Managed-Agent era are excluded via .dockerignore.
COPY skills ./skills
# Plugin manifests. The loader reads these at boot to build the plugin
# catalog. Without them every integration/agent/channel stays uninstalled in
# production because legacy-bootstrap cannot find a matching catalog entry.
# Path must match PLUGIN_MANIFEST_DIR above.
COPY docs/harness-platform/examples ./plugin-manifests
# Bootstrap-Profiles (S+12) — profileLoader.ts liest hier die curated
# Plugin-Stacks (production / minimal-dev / blank). Ohne Pfad findet das
# Onboarding-Modal keine Profile.
COPY middleware/profiles ./profiles
ENV PROFILES_DIR=/app/profiles
# Plugin-Builder Boilerplate (B.1+) — boilerplateSource.ts liest hier die
# Template-Files für die Codegen-Engine. Whole-tree COPY damit beide Templates
# (agent-integration, agent-pure-llm) im Image landen; BUILDER_BOILERPLATE_DIR
# zeigt auf den Root, einzelne Templates werden via templateId resolved.
COPY docs/harness-platform/boilerplate ./boilerplate
ENV BUILDER_BOILERPLATE_DIR=/app/boilerplate
# Entity-Registry (Builder-Vocabulary) — entityVocabulary.ts liest die yaml
# beim Boot ein. Ohne env-var würde der dist-relative Walk auf `/docs/...` zielen.
COPY docs/harness-platform/entity-registry.v1.yaml ./entity-registry.v1.yaml
ENV BUILDER_ENTITY_REGISTRY_PATH=/app/entity-registry.v1.yaml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Prepare /data so the first boot without a mounted volume also works.
RUN mkdir -p /data/memory && chown -R node:node /data /app

EXPOSE 8080

# Entrypoint runs as root so it can chown the Fly volume (mounted as root:root by
# default), then drops to the `node` user via gosu.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
