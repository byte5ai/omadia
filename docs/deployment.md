# Deployment

Run omadia beyond your own machine: one click on Render, one command on Fly.io,
or any host that runs Node and Postgres. For a local install, see
[Getting started](getting-started.md).

## Required production secrets

The shipped image runs with `NODE_ENV=production`, which makes **two** keys
mandatory at boot: `VAULT_KEY` (secret vault) and, since v0.115,
`CREDENTIAL_KEYCHAIN_KEY` (credential keychain, a separate trust domain, so a
separate key). Without either the middleware refuses to start (this is
intentional; the dev fallback writes the master keys into the data volume, which
is not safe at rest). Generate each with `openssl rand -base64 32` (two
different values, never rotated casually) and wire both as platform secrets
before the first deploy. The Render blueprint and `fly/deploy.sh` generate both;
on a self-managed host set them yourself before first boot.

Upgrading an existing instance from a version older than v0.115? Add
`CREDENTIAL_KEYCHAIN_KEY` **before** pulling the new image, or the boot health
gate fails and the rolling updater rolls back. The bundled `docker-compose.yaml`
pins `NODE_ENV=development` so the dev fallback stays available for local
`docker compose up` without configuration; drop that override (and set
`VAULT_KEY` in `.env`) when you re-use the compose file as a starting point for
a non-local deploy.

## Targets

- **One-click cloud**: deploy the minimal core into your own Render
  workspace. [`render.yaml`](../render.yaml) provisions the middleware,
  admin UI, and Postgres (pgvector), and generates `VAULT_KEY` and
  `CREDENTIAL_KEYCHAIN_KEY`. On first boot the middleware log shows the one-time
  setup token the first-admin `/setup` wizard asks for; your LLM is connected
  afterwards under **Admin → LLM access**. Runs on paid instance types (the
  middleware needs a persistent disk).

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/byte5ai/omadia)

- **One-command Fly.io**: Fly has no blueprint-style deploy button, so the
  equivalent is one command. [`fly/deploy.sh`](../fly/deploy.sh) provisions
  three apps in your Fly org: middleware (persistent `/data` volume),
  admin UI, and a private [`pgvector/pgvector`](https://hub.docker.com/r/pgvector/pgvector)
  Postgres (the same image the compose stack uses; Fly's own Postgres
  offerings either lack pgvector or gate it behind a dashboard toggle). It
  generates `VAULT_KEY`, `CREDENTIAL_KEYCHAIN_KEY` and the database password,
  and deploys the GHCR images. Needs a logged-in `flyctl`; roughly $10/month.
  The `/setup` wizard then asks for the setup token from
  `fly logs -a <middleware-app>`:

  ```bash
  git clone https://github.com/byte5ai/omadia.git && cd omadia
  ./fly/deploy.sh
  ```

- **Bring-your-own**: the runtime is a stock Node + Postgres app; any host
  that can run both works (Kubernetes, ECS, plain VM).

To move a running deployment to a newer version, follow the
[upgrade guide](upgrading.md).

## Troubleshooting

**`VAULT_KEY` or `CREDENTIAL_KEYCHAIN_KEY` missing at boot.** A production
image (`NODE_ENV=production`) refuses to start without both keys, on purpose
(`CREDENTIAL_KEYCHAIN_KEY is required when NODE_ENV=production` is the
message since v0.115). Generate each with `openssl rand -base64 32` and set
them as secrets before deploying.

**Update rolled back with `health gate failed: never_reachable`.** The new
image never answered `/health` within the gate window, so the updater restored
the previous version, and the instance keeps running. The most common cause is a
secret the new version requires at boot that the old one did not, above all
`CREDENTIAL_KEYCHAIN_KEY` when coming from a version older than v0.115. Check
the middleware logs from the failed boot right away (hosted log retention is
short), add the missing secret, and re-run the update. See
[Required production secrets](#required-production-secrets).
