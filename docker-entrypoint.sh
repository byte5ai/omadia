#!/bin/sh
# Runs as root on container start. Ensures the Fly volume at /data is owned by the
# non-root `node` user before execing the app. Fly volumes mount as root:root and
# survive across deploys, so the chown is idempotent and cheap.
set -eu

mkdir -p /data/memory
chown -R node:node /data

exec gosu node node dist/index.js
