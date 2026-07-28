# syntax=docker/dockerfile:1.7
# Epic #470 W1 — dev-platform runner daemon image (spec §2/§4).
#
# STANDALONE: dockerode + zod + node builtins only, so the image never inherits
# the middleware's dependency surface. One image, two entrypoints — `daemon.mjs`
# (control plane) and, in a later W1 unit, `proxy.mjs` (egress data plane); the
# compose overlay picks the command per service.
#
# The runtime imports the shared wire schema straight from `src/protocol.ts`;
# node >= 22.18 strips the TS types at load time, so no separate build step is
# needed for this scaffold. `tini` reaps the child processes the daemon spawns;
# the container runs as a non-root user.
FROM node:22.23.1-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Install production deps only (dockerode + zod). Copy manifests first so the
# layer caches across source-only changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Daemon-side image clamp (spec §4, round-3 high finding). The daemon REFUSES to
# start without DEV_RUNNER_ALLOWED_IMAGES (the operator sets it in the compose
# overlay to the bare runner repositories it is allowed to run, e.g.
# `ghcr.io/byte5ai/omadia-dev-runner`). Digest-pinning is required by default; the
# warmer unit resolves the configured tag to a digest.
ENV DEV_RUNNER_REQUIRE_DIGEST=true

# node:22-alpine ships a `node` user (uid 1000); run unprivileged.
USER node

EXPOSE 7411

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/daemon.mjs"]
