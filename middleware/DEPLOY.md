# Fly.io Deployment

## Prerequisites

- [`flyctl`](https://fly.io/docs/flyctl/install/) installed (`brew install flyctl`)
- Fly.io account with a payment method (hobby tier is enough, ~$3–5/month)
- The Odoo Accounting Managed Agent already created in the Claude Console
  (you need `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID`)

## One-time setup

```bash
cd middleware

# 1. Authenticate
fly auth login

# 2. Pick a globally-unique app name (change `app = ...` in fly.toml if needed)
#    Then provision the app without deploying yet:
fly launch --no-deploy --copy-config

# 3. Provision the persistent volume. Size it conservatively — 1 GB holds
#    millions of small memory markdown files.
fly volumes create memory_data --region fra --size 1

# 4. Set secrets (encrypted at rest on Fly — values are NEVER shown again).
#    Generate the admin token first and SAVE IT to your password manager
#    before pushing it to Fly; there is no "recover value" path afterwards.
ADMIN_TOKEN=$(openssl rand -hex 32)
echo "ADMIN_TOKEN = $ADMIN_TOKEN   ← store this in 1Password/Keeper now"

fly secrets set \
  ANTHROPIC_API_KEY="sk-ant-…" \
  CLAUDE_AGENT_ID="agent_…" \
  CLAUDE_ENVIRONMENT_ID="env_…" \
  ADMIN_TOKEN="$ADMIN_TOKEN"

# 5. (Optional) Microsoft Teams integration. The /api/messages endpoint is
#    only mounted when MICROSOFT_APP_ID and MICROSOFT_APP_PASSWORD are both set.
#    Use `MultiTenant` by default; switch to `SingleTenant` (and set
#    MICROSOFT_APP_TENANT_ID) if you want to lock the bot to your AAD tenant.
fly secrets set \
  MICROSOFT_APP_ID="<app-registration-id>" \
  MICROSOFT_APP_PASSWORD="<client-secret-value>" \
  MICROSOFT_APP_TYPE="MultiTenant"
# MICROSOFT_APP_TENANT_ID="<aad-tenant-id>"   # only for SingleTenant

# 5. First deploy
fly deploy
```

## Subsequent deploys

```bash
fly deploy
```

Logs & inspection:

```bash
fly logs                              # live logs
fly ssh console                       # shell into the running container
fly ssh console -C "ls /data/memory"  # inspect memory files
fly status                            # machine state + volume info
```

## Updating memory

Three channels, in order of reach:

1. **Repo-driven (baseline):** edit files under `middleware/seed/memory/`,
   commit, `fly deploy`. With `MEMORY_SEED_MODE=missing` (default) only new
   files get seeded; existing ones are left alone. Set
   `MEMORY_SEED_MODE=overwrite` via `fly secrets set` if you want the repo
   version to win.

2. **Admin HTTP API (runtime, no redeploy):**
   ```bash
   APP=odoo-bot-middleware.fly.dev
   TOKEN=$(fly secrets list | awk '/ADMIN_TOKEN/ {print "use `fly secrets set` to view — Fly never prints secret values"}')
   # ^ Fly never surfaces secret values again; keep ADMIN_TOKEN in your own password manager.

   curl -sS -X PUT "https://$APP/api/admin/memory" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"path":"/memories/customers/acme.md","content":"# ACME\n…","mode":"overwrite"}'

   curl -sS "https://$APP/api/admin/memory/_rules/accounting-conventions.md" \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

3. **Claude itself:** via the `memory` tool during ordinary chat turns.
   This is the organic growth path.

## Scaling notes

- Volumes are **region-scoped**: `memory_data` lives in `fra` only. For
  multi-region, migrate to an object-storage-backed `MemoryStore` (see
  `src/memory/store.ts` — the interface is already the abstraction seam).
- `auto_stop_machines = "stop"` + `min_machines_running = 0` give you
  scale-to-zero. First request after idle has a ~1–2 s cold-start penalty.
  The memory volume persists across stops.
- Horizontal scaling within a region is possible but the filesystem store
  wasn't designed for concurrent writes — keep it single-instance for now.

## Uninstall

```bash
fly apps destroy odoo-bot-middleware
fly volumes list     # show any stray volumes
fly volumes destroy <id>
```
