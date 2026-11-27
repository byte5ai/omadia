#!/bin/sh
# Runs as root on container start. Ensures the Fly volume at /data is owned by the
# non-root `node` user before execing the app. Fly volumes mount as root:root and
# survive across deploys, so the chown is idempotent and cheap.
set -eu

mkdir -p /data/memory
chown -R node:node /data
# #2306 / ADR-0270 — stdio MCP servers run as `omadia-mcp`; they must not read
# the vault, secrets or uploads. Re-applied on every start because an existing
# volume (Fly, Compose) was created with the default 0755.
chmod 0700 /data
# Fly exposes the Machines API as the unix socket /.fly/api inside the VM. The
# middleware does not use it; close it to everyone but root so a stdio child
# cannot manage the app's machines through it. Only when present (Fly), and a
# failure never stops the boot.
if [ -S /.fly/api ]; then
  chmod 0600 /.fly/api 2>/dev/null || echo "[entrypoint] could not restrict /.fly/api" >&2
fi

exec gosu node node dist/index.js
