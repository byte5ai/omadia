# syntax=docker/dockerfile:1.7
# omadia/dev-runner — hardened per-job execution image (epic #470 W1, spec §3).
#
# Runs exactly ONE dev job: the runner shim clones a repo read-only over HTTPS,
# drives the headless Claude CLI, streams events home to the middleware, and
# uploads a diff. The shim holds NO write credential and moves NO ref — the
# middleware applies the reviewed diff server-side (W0 v2 §8).
#
# The image ships NO credentials and NO omadia secrets. Everything a job needs
# arrives per-job at runtime: the job token via env, and the git token via the
# credential helper fetched at use time. Nothing durable is baked in.
#
# Build context is the REPO ROOT (same as the middleware image at ./Dockerfile)
# so the shim workspace package at middleware/packages/dev-runner-shim/ can be
# compiled in-image without duplicating its source.

# --- shim build stage -------------------------------------------------------
# The shim is a Node-builtins-only workspace package (middleware/packages/
# dev-runner-shim). It has ONLY devDependencies (typescript/tsx/@types/node) and
# no runtime node_modules, so we compile it with tsc and ship the emitted dist/
# tree — no bundler, and zero runtime dependency surface in the final image.
FROM node:22.23.1-slim AS shim-builder
WORKDIR /build
COPY middleware/packages/dev-runner-shim/package.json ./
# No package-lock.json in the workspace package (the root middleware lockfile
# covers it); `npm install` resolves the three pinned devDeps for the build.
RUN npm install --no-audit --no-fund
COPY middleware/packages/dev-runner-shim/ ./
RUN npm run build

# --- runtime stage ----------------------------------------------------------
FROM node:22.23.1-slim
# Pin the Claude CLI to the SAME version as the middleware Dockerfile (repo-root
# ./Dockerfile ARG CLAUDE_CODE_VERSION). Bump both together — a drift here means
# a dev job runs a different CLI than the rest of the platform.
ARG CLAUDE_CODE_VERSION=2.1.187
# git + ca-certificates: HTTPS-only clone (W1 has NO openssh-client — SSH clone
# is out of scope, spec §3). ripgrep: the CLI's file search. tini: PID 1 that
# reaps the CLI and git children on SIGTERM so a cancelled job leaves no
# zombies. The CLI itself is installed globally at the pinned version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
# uid 1000 already exists in the node image (the `node` user); `|| true` keeps
# the build idempotent. The container runs by NUMERIC uid:gid regardless, so no
# named user is required.
RUN useradd -u 1000 -m runner || true
# Compiled shim (tsc multi-file ESM, dist/src/*.js). Entrypoint is index.js,
# which self-invokes via its import.meta.url main guard.
COPY --from=shim-builder /build/dist/src /opt/omadia/shim
LABEL org.opencontainers.image.source="https://github.com/byte5ai/omadia" \
      ai.omadia.runner.protocol="1"
# CLI config lands in a writable tmpfs path — the daemon mounts the rootfs
# read-only, so $HOME is not writable; /tmp is the only writable exec surface.
ENV CLAUDE_CONFIG_DIR=/tmp/claude-cli
WORKDIR /workspace
USER 1000:1000
# tini reaps the CLI + git; the shim is the single long-lived process per job.
ENTRYPOINT ["tini", "--", "node", "/opt/omadia/shim/index.js"]
