#!/usr/bin/env bash
# One-command Fly.io deploy of the omadia minimal core — the Fly
# counterpart to the repo-root render.yaml blueprint.
#
#   ./fly/deploy.sh
#
# Provisions three Fly apps in YOUR Fly org (your account, your bill):
#   - omadia-postgres-<suffix>    pgvector/pgvector:pg17, private-only
#   - omadia-middleware-<suffix>  kernel API, persistent /data volume
#   - omadia-web-ui-<suffix>      admin UI, public entrypoint
#
# Secrets are generated here (VAULT_KEY, CREDENTIAL_KEYCHAIN_KEY, Postgres
# password); the LLM key
# is collected by the /setup wizard on first boot — nothing to paste.
#
# Prerequisites: flyctl installed and logged in (fly auth login), and
# openssl on PATH. Cost: three shared-cpu machines + two 1 GB volumes,
# roughly $10/month depending on usage.
#
# Overridable via environment:
#   FLY_ORG        Fly org slug                      (default: personal)
#   FLY_REGION     region for volumes/machines       (default: fra —
#                  if you change it, also change primary_region in the
#                  three fly/*.fly.toml files)
#   OMADIA_SUFFIX  app-name suffix; Fly app names    (default: random)
#                  are globally unique, hence one
#   OMADIA_WITH_UPDATER=1  also provision the updater sidecar app, which
#                  enables one-click updates from Admin → Update (#696).
#                  Opt-in: it mints app-scoped deploy tokens for the
#                  middleware and web-ui apps and holds them.
#
# This is a one-shot installer, not an upgrade tool. To upgrade later:
#   fly deploy --app <middleware-app> --config fly/middleware.fly.toml
#   fly deploy --app <web-ui-app>     --config fly/web-ui.fly.toml
# To tear everything down: fly apps destroy <each app>.

set -euo pipefail

FLY="$(command -v fly || command -v flyctl || true)"
if [ -z "$FLY" ]; then
  echo "flyctl not found — install it first: https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

ORG="${FLY_ORG:-personal}"
REGION="${FLY_REGION:-fra}"
SUFFIX="${OMADIA_SUFFIX:-$(openssl rand -hex 3)}"
PG_APP="omadia-postgres-${SUFFIX}"
MW_APP="omadia-middleware-${SUFFIX}"
UI_APP="omadia-web-ui-${SUFFIX}"

cd "$(dirname "$0")"

echo "==> Creating apps in org '${ORG}' (suffix: ${SUFFIX})"
"$FLY" apps create "$PG_APP" --org "$ORG"
"$FLY" apps create "$MW_APP" --org "$ORG"
"$FLY" apps create "$UI_APP" --org "$ORG"

echo "==> Creating volumes in ${REGION}"
"$FLY" volumes create omadia_pgdata --app "$PG_APP" --region "$REGION" --size 1 --yes
"$FLY" volumes create omadia_data --app "$MW_APP" --region "$REGION" --size 1 --yes

echo "==> Setting secrets"
PG_PASSWORD="$(openssl rand -hex 16)"
"$FLY" secrets set --app "$PG_APP" \
  POSTGRES_PASSWORD="$PG_PASSWORD"
"$FLY" secrets set --app "$MW_APP" \
  VAULT_KEY="$(openssl rand -base64 32)" \
  CREDENTIAL_KEYCHAIN_KEY="$(openssl rand -base64 32)" \
  DATABASE_URL="postgresql://omadia:${PG_PASSWORD}@${PG_APP}.internal:5432/omadia"
"$FLY" secrets set --app "$UI_APP" \
  MIDDLEWARE_URL="http://${MW_APP}.internal:8080"

echo "==> Deploying Postgres (${PG_APP})"
"$FLY" deploy --app "$PG_APP" --config pg.fly.toml --ha=false

echo "==> Deploying middleware (${MW_APP}) — first boot runs migrations, allow a minute"
# If the middleware wins the race against initdb on the very first boot,
# its machine exits and Fly's restart policy retries until Postgres is up.
"$FLY" deploy --app "$MW_APP" --config middleware.fly.toml --ha=false

echo "==> Deploying admin UI (${UI_APP})"
"$FLY" deploy --app "$UI_APP" --config web-ui.fly.toml --ha=false

# --- Optional: one-click updates from the Operator UI (issue #696) ----------
# Opt-in, like the compose overlay: replacing running machines is a capability
# no deployment should acquire by accident. Without it the admin page still
# reports versions and flags a newer release, it just cannot apply one.
if [ "${OMADIA_WITH_UPDATER:-0}" = "1" ]; then
  UPD_APP="omadia-updater-${SUFFIX}"
  echo "==> Creating updater app (${UPD_APP})"
  "$FLY" apps create "$UPD_APP" --org "$ORG"

  # App-SCOPED deploy tokens: one per app the updater may move, and nothing
  # else in the org. `fly tokens create deploy` prints the token on stdout.
  echo "==> Minting app-scoped deploy tokens"
  MW_TOKEN="$("$FLY" tokens create deploy --app "$MW_APP" --name "omadia-updater ${SUFFIX} middleware" --expiry 8760h)"
  UI_TOKEN="$("$FLY" tokens create deploy --app "$UI_APP" --name "omadia-updater ${SUFFIX} web-ui" --expiry 8760h)"
  UPDATER_TOKEN="$(openssl rand -hex 24)"

  "$FLY" secrets set --app "$UPD_APP" \
    UPDATER_TOKEN="$UPDATER_TOKEN" \
    UPDATER_FLY_APP_MIDDLEWARE="$MW_APP" \
    UPDATER_FLY_TOKEN_MIDDLEWARE="$MW_TOKEN" \
    UPDATER_FLY_APP_WEB_UI="$UI_APP" \
    UPDATER_FLY_TOKEN_WEB_UI="$UI_TOKEN" \
    UPDATER_HEALTH_URL="http://${MW_APP}.internal:8080/health"

  # This pair is what flips the admin page out of notify-only mode.
  "$FLY" secrets set --app "$MW_APP" \
    OMADIA_UPDATER_URL="http://${UPD_APP}.internal:8090" \
    OMADIA_UPDATER_TOKEN="$UPDATER_TOKEN"

  echo "==> Deploying updater (${UPD_APP})"
  "$FLY" deploy --app "$UPD_APP" --config updater.fly.toml --ha=false
fi

echo
echo "Done. Open https://${UI_APP}.fly.dev and finish the /setup wizard"
echo "(first admin + LLM key, stored encrypted in the vault)."
echo
echo "The middleware is public at https://${MW_APP}.fly.dev (needed for"
echo "channel webhooks). VAULT_KEY and CREDENTIAL_KEYCHAIN_KEY live only as Fly"
echo "secrets on ${MW_APP}; losing them makes vault / keychain entries unrecoverable."
