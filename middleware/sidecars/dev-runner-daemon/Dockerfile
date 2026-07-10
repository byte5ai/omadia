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

# node:22-alpine ships a `node` user (uid 1000); run unprivileged.
USER node

EXPOSE 7411

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/daemon.mjs"]
