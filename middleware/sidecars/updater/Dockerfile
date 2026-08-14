# syntax=docker/dockerfile:1.7
# omadia updater sidecar (#432) — operator-triggered rolling self-update.
#
# ZERO npm dependencies: node builtins only (`node:http` for both the control
# plane and the Docker Engine API client). This is the one container in the
# stack that can replace every other container, so its dependency surface is
# kept at nothing rather than merely small — no lockfile, no transitive tree,
# nothing to audit but the files in src/.
#
# It never mounts /var/run/docker.sock. All Engine access goes through the
# docker-socket-proxy service defined in docker-compose.update.yaml, whose
# endpoint allowlist is visible in that file.
FROM node:22.23.2-alpine

RUN apk add --no-cache tini

WORKDIR /app
COPY src ./src

# Fail-fast contract (src/config.mjs): the container refuses to start without
# UPDATER_TOKEN. Nothing is defaulted here that would weaken that.
ENV UPDATER_PORT=8090

# node:22-alpine ships a `node` user (uid 1000); run unprivileged. The bind
# mount of the project .env must be writable by this uid — see the overlay.
USER node

EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.mjs"]
