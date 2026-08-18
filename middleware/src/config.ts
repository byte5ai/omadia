import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

import type { RegistryConfigEntry } from './api/registry-v1.js';
// TYPE-ONLY (erased at build): core builds the dev platform's config namespace but
// does not otherwise depend on the subsystem. When the dev platform is extracted,
// this import and `buildDevPlatformConfig` below are the only things to delete.
import type { DevPlatformConfig } from './devplatform/config.js';

// Resolve .env relative to this file so the server works from any CWD.
const here = path.dirname(fileURLToPath(import.meta.url));
// From src/ or dist/ the project root is always one directory up.
// `override: true` so .env wins over any pre-set (possibly empty) shell vars.
dotenv.config({ path: path.resolve(here, '..', '.env'), override: true });

/**
 * Optional env var whose *empty* value must be treated as unset rather than
 * validated. Operators (and `compose` `environment:` interpolation of an
 * unset shell var) routinely export `FOO=` to mean "not configured". A plain
 * `z.string().url().optional()` / `.min(32).optional()` crashes boot on `FOO=`
 * because an empty string is a *present* value that still runs the inner
 * constraint. `z.preprocess` runs the empty→undefined coercion BEFORE the
 * inner schema, so `.optional()` short-circuits for blanks while real values
 * are still format-checked. Mirrors the inline DATABASE_URL transform below.
 */
const optionalNonEmpty = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    inner.optional(),
  );

/** A boolean env flag, off by default — the `'true'|'false'` string pattern used
 *  across this schema (an unset var short-circuits to `false`). */
const devFlag = () =>
  z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false);

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3979),

  // Interface to bind. Defaults to dual-stack `::` (all interfaces) so Fly-Edge
  // IPv6 + flycast keep working. A local single-tenant install (e.g. the omadia
  // desktop app) sets `HOST=127.0.0.1` so the kernel is NOT reachable on the LAN
  // — the desktop threat model is loopback-only.
  HOST: z.string().min(1).default('::'),

  // Anthropic SDK — optional since OB-61: the operator can supply the key
  // through the /setup wizard on first boot (vault-stored per plugin), so
  // an empty ENV is now a valid state. When unset AND the vault has no key
  // either, the orchestrator + verifier + orchestrator-extras plugins
  // register but their LLM-bound capabilities stay unpublished until the
  // operator runs /setup or PATCHes a key via /api/v1/admin/runtime/secrets.
  ANTHROPIC_API_KEY: z.string().optional(),
  ORCHESTRATOR_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ORCHESTRATOR_MAX_TOKENS: z.coerce.number().int().positive().default(8192),

  // Per-turn Sonnet/Opus routing (opt-in). When ON, a cheap Haiku classifier
  // picks the model per turn: simple → ROUTING_SIMPLE_MODEL, complex →
  // ROUTING_COMPLEX_MODEL. Seeded into the orchestrator plugin config so it is
  // also editable at runtime via /api/v1/admin/settings. The *_MODEL overrides
  // are optional — the orchestrator falls back to sensible defaults (classifier
  // → TOPIC_CLASSIFIER_MODEL/haiku, simple → SUB_AGENT_MODEL/sonnet, complex →
  // ORCHESTRATOR_MODEL) when they're unset.
  ORCHESTRATOR_MODEL_ROUTING: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  // #445 — sticky Direct Line. When on, a bare `#<agent>` binds the
  // conversation to that specialist until the user sends `#end` /
  // `#orchestrator`. Default OFF: not every channel can show which specialist
  // is answering (Telegram renders neither the consulted footer nor the
  // delegated-answer attribution today), and an invisible sticky mode would
  // break the "never ambiguous who is answering" requirement this exists for.
  ORCHESTRATOR_DIRECT_LINE_STICKY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  MODEL_ROUTING_CLASSIFIER_MODEL: z.string().min(1).optional(),
  MODEL_ROUTING_SIMPLE_MODEL: z.string().min(1).optional(),
  MODEL_ROUTING_COMPLEX_MODEL: z.string().min(1).optional(),

  // Sub-agent runtime (Odoo Accounting, Odoo HR, Confluence Playbook). These
  // sub-agents run locally inside the middleware; skill markdown lives under
  // SKILLS_DIR. Model default matches the orchestrator; override to run
  // sub-agents cheaper (Sonnet/Haiku) while keeping the orchestrator on Opus.
  SUB_AGENT_MODEL: z.string().min(1).default('claude-opus-4-8'),
  SUB_AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  SUB_AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(16),

  // BuilderAgent runtime — separate from SUB_AGENT_MAX_TOKENS because
  // fill_slot generates whole TS slot bodies (5–15k output tokens for a
  // realistic plugin slot is normal). With 4096 the model would emit
  // `{"slotKey":"…","source":"<truncated>` and the SDK aggregator would
  // drop the partial source field, producing zod errors that look like
  // "Required: source" — see OB-31. 16384 covers the common cases;
  // operators can bump to the model's max (32k for opus-4-7) via env.
  BUILDER_AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(16384),
  SKILLS_DIR: z.string().min(1).default('../skills'),

  // Memory persistence backend selection.
  //   postgres → @omadia/memory-postgres (PostgresMemoryStore) — requires
  //              DATABASE_URL (the Neon KG provides the shared graphPool the
  //              Postgres store consumes). Without DATABASE_URL the bootstrap
  //              falls back to inmemory.
  //   inmemory → @omadia/memory (InMemoryMemoryStore, RAM-only, DB-less).
  // NO default: when unset the bootstrap derives the default from DATABASE_URL
  // (DATABASE_URL ? postgres : inmemory) — so Postgres is sharp by default
  // whenever a DB is configured. A persisted operator choice (UI) takes
  // precedence over this env value (see bootstrapMemoryFromEnv).
  MEMORY_BACKEND: z.enum(['postgres', 'inmemory']).optional(),
  MEMORY_SEED_DIR: z.string().min(1).default('./seed/memory'),
  MEMORY_SEED_MODE: z.enum(['missing', 'overwrite', 'skip']).default('missing'),

  // Admin endpoint auth. Empty/unset disables the admin endpoint entirely.
  ADMIN_TOKEN: z.string().optional(),

  // Harness admin OAuth (A.1). ADMIN_ALLOWED_EMAILS holds a comma-separated
  // whitelist of byte5 emails that may mint a session. When the list is
  // empty the /api/v1/auth/* routes still run but every sign-in gets 403 —
  // use an ADMIN_TOKEN-authenticated break-glass path to recover.
  ADMIN_ALLOWED_EMAILS: z.string().optional(),

  // OB-49 — provider-aware auth. Comma-separated list of active provider
  // ids ('local', 'entra', or future plugin ids). Default 'local,entra'
  // so any operator who already has MICROSOFT_APP_* wired sees Entra on
  // the login picker out of the box; entra is silently skipped (with a
  // log warning) when those secrets are missing, so a fresh OSS-Demo
  // still lands on a working local-only login page. Override to 'entra'
  // alone to disable local-password sign-in entirely.
  AUTH_PROVIDERS: z.string().default('local,entra'),

  // OB-49 first-boot seed. When the users table is empty AND both vars
  // are set, the bootstrap creates a single admin user with these creds.
  // Otherwise the unauthenticated /api/v1/auth/setup wizard is mounted
  // and the operator completes setup via the browser. Either path is a
  // one-shot: once any user exists, both paths refuse.
  ADMIN_BOOTSTRAP_EMAIL: z.string().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),
  ADMIN_BOOTSTRAP_DISPLAY_NAME: z.string().optional(),
  // Public base URL the `return` redirect lands on after a successful
  // login. In prod this is the middleware host itself (admin UI eventually
  // moves to its own Fly app → point this at that host). In dev it's the
  // Next.js origin (localhost:3000) so the Set-Cookie from the callback
  // lands on the SAME domain the browser is on — cookies don't cross hosts.
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3979'),
  // Spec 004 (FR-B5) — browser-facing origin that plugin flow-callback URLs
  // (`ctx.flows.publicUrl`) resolve against. Defaults to PUBLIC_BASE_URL; set
  // it only when flow callbacks must land on a different origin than the rest
  // of the admin UI (rare). Mirrors the AUTH_REDIRECT_URI precedent.
  FLOW_PUBLIC_BASE_URL: z.string().url().optional(),
  // Epic #459 W9 — absolute redirect URI the MCP OAuth callback lands on. Set
  // only when the callback must resolve on a different origin than
  // FLOW_PUBLIC_BASE_URL/api/v1/operator/mcp-oauth/callback (the default).
  MCP_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // Absolute URL Azure AD redirects to after login. MUST be registered
  // verbatim in the MS365 App Registration. In prod: middleware's own
  // /api/v1/auth/callback. In dev: http://localhost:3000/bot-api/v1/auth/callback
  // so Next's rewrite forwards the callback back into the middleware while
  // keeping the browser on localhost:3000 for the cookie.
  AUTH_REDIRECT_URI: z.string().url().optional(),
  // Path we bounce users to after a successful login when no ?return param
  // was supplied. Defaults to `/` because the admin UI's root is the chat
  // landing page.
  AUTH_DEFAULT_RETURN_PATH: z.string().default('/'),

  // Friction-free desktop pairing (#293). The server owns the mapping
  // "human-facing URL → canvas transport URL"; these knobs let one config
  // serve every deployment shape without code-level topology lock-in.
  //
  // OMADIA_UI_PUBLIC_WS_URL — absolute `wss://…/omadia-ui/canvas` the desktop
  // app should connect to. Leave unset for LAN / single-service hosts (the
  // discovery endpoint derives it from the request origin). Set it in a SPLIT
  // deployment where the operator front and the canvas transport are on
  // different hosts (e.g. the Fly operator/middleware split) so discovery
  // hands the client the transport host it cannot otherwise guess.
  OMADIA_UI_PUBLIC_WS_URL: optionalNonEmpty(z.string().url()),
  // Human label advertised over mDNS + returned in the pairing descriptor.
  // Defaults to the request host when unset.
  OMADIA_UI_INSTANCE_NAME: optionalNonEmpty(z.string()),
  // Advertise `_omadia._tcp` on the LAN for zero-config discovery. On by
  // default for self-hosters; harmless to leave on where there is no LAN
  // reachability (Fly), but set to `false` to silence the responder there.
  OMADIA_UI_MDNS_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),

  // #575 — enforce the audience floor: a room may only do what EVERY
  // participant is granted. Off by default, and that default is load-bearing
  // rather than cautious. The floor fails closed by design, so switching it on
  // against an empty grant table does not mean "no policy yet" — it means every
  // tool refused, no context recalled and no attachment readable, in every
  // room, at once. Seed and review the grants through
  // /api/v1/admin/audience-grants (available whenever Postgres is), THEN set
  // this. It also needs Postgres: with the in-memory backend there is nowhere
  // durable for grants to live, and a restart would shut the rooms.
  AUDIENCE_FLOOR_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),

  // Local-dev endpoints (raw graph browser, memory browser, …) under /api/dev.
  //
  // Issue #669: these used to mount WITHOUT authentication, so this flag alone
  // published knowledge-graph state — and three destructive maintenance sweeps —
  // to anyone who knew the path. They now sit behind the same operator session
  // gate as every other /api route, and the KG-Lifecycle / priorities operator
  // pages moved to /api/v1/admin/kg-* so they no longer need this flag at all.
  // Still dev scaffolding: leave it off unless you are iterating on the
  // Next.js dev UI against a local middleware.
  DEV_ENDPOINTS_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),

  // Issue #669 — belt-and-braces for /api/dev: refuse any request that did not
  // arrive over a loopback socket (403), on top of the session gate. Off by
  // default because a containerised dev setup proxies through the Next.js
  // server from a non-loopback address. See auth/loopbackOnly.ts.
  DEV_ENDPOINTS_LOOPBACK_ONLY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),

  // Epic #470 W4 — GitHub webhook trigger controls (spec §3). The global kill
  // switch defaults ON (a per-repo `webhook_enabled` and an empty sender allowlist
  // already keep it off until an operator opts a repo in). The two rate limits cap
  // how many jobs a single repo / single sender can spawn per rolling hour.
  DEV_WEBHOOKS_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
  DEV_WEBHOOK_MAX_JOBS_PER_REPO_HOUR: z.coerce.number().int().positive().default(5),
  DEV_WEBHOOK_MAX_JOBS_PER_SENDER_HOUR: z.coerce.number().int().positive().default(2),

  // Issue #437 — Conductor's generic inbound webhook route (`POST /api/hooks/:endpointId`).
  // Per-endpoint secrets already gate every request (Vault-backed, see webhookEndpointStore.ts);
  // this is the same operator-facing global kill switch DEV_WEBHOOKS_ENABLED is for the
  // dev-platform's GitHub route, kept separate because the two features are unrelated.
  CONDUCTOR_WEBHOOKS_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
  // Per-endpoint cap over a rolling minute — closes the gap dedupe alone leaves open
  // (a correctly-signed sender can mint a fresh delivery id on every call, so it
  // would otherwise start an unbounded number of workflow runs). Enforced atomically
  // in ConductorWebhookEndpointStore.claim(), same transaction as the dedupe insert.
  CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // Review finding: the operator UI must show the inbound endpoint URL
  // (`/api/hooks/:endpointId`) as an address the sender can ACTUALLY reach — the
  // middleware's own base URL, not `window.location.origin` (in the standard local
  // dev setup that's the Next.js dev server, which only proxies `/bot-api/*` per
  // `web-ui/next.config.ts`; `/api/hooks/*` there 404s). Same fallback shape as
  // `FLOW_PUBLIC_BASE_URL ?? PUBLIC_BASE_URL`: set this only when the inbound
  // webhook route must be advertised on a different origin than the rest of the
  // admin UI (e.g. PUBLIC_BASE_URL is deliberately the browser-facing Next.js
  // origin in dev, while the webhook route only ever lives on the middleware).
  CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL: z.string().url().optional(),

  // Epic #470 W4 — default per-job LLM cost budget (USD) applied when neither the
  // job nor its repo sets one (spec §5). Token budgets have NO default: they are
  // enforced only when explicitly set on the job or repo.
  DEV_JOB_DEFAULT_BUDGET_USD: z.coerce.number().positive().default(100),

  // Postgres connection string for the Neon-backed knowledge graph.
  // When set, `bootstrapKnowledgeGraphFromEnv` installs the
  // harness-knowledge-graph-neon sibling; when unset, the inmemory
  // sibling is installed. Empty-string is treated as unset (operator
  // typically exports `""` to mean "no backend"). The neon plugin
  // reads its effective DSN from installed.json config (set by
  // bootstrap) — this Config field is the input boundary at process
  // start, not the persistent storage. (S+12.5-3 additionally
  // migrates the persistent storage from installed.json → Vault.)
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),

  // Knowledge-graph tenant scope. Same value the NeonKnowledgeGraph reads
  // directly from process.env; declared here too so the diagram service can
  // use it as the cache-key prefix without a parallel env read.
  GRAPH_TENANT_ID: z.string().min(1).default('default'),

  // Microsoft Bot Framework / Teams. When MICROSOFT_APP_ID is empty/unset,
  // the /api/messages endpoint is not mounted — useful for local dev.
  MICROSOFT_APP_ID: z.string().optional(),
  MICROSOFT_APP_PASSWORD: z.string().optional(),
  MICROSOFT_APP_TYPE: z
    .enum(['MultiTenant', 'SingleTenant', 'UserAssignedMSI'])
    .default('MultiTenant'),
  MICROSOFT_APP_TENANT_ID: z.string().optional(),
  /**
   * Bot Framework OAuth Connection Name (configured in Azure Bot Service).
   * When set, the Teams bot attempts to retrieve a Teams SSO assertion for
   * each message and threads it into the orchestrator as `ssoAssertion`,
   * enabling the calendar tools. Unset → calendar tools stay dormant (no
   * OAuth flow, no consent prompts).
   */
  TEAMS_SSO_CONNECTION_NAME: z.string().optional(),

  // Telegram channel. When TELEGRAM_BOT_TOKEN is set, the channel package is
  // auto-installed at boot. TELEGRAM_WEBHOOK_SECRET is required alongside it
  // (HMAC-style header validation on the webhook). TELEGRAM_PUBLIC_BASE_URL
  // is optional — when missing, the channel falls back to long-polling.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_PUBLIC_BASE_URL: z.string().url().optional(),

  // Orchestrator safety rails
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(12),

  // Confluence credentials. When set, the Confluence sub-agent is enabled.
  // Atlassian creds stay in-process — never echoed to any model prompt.
  CONFLUENCE_EMAIL: z.string().email().optional(),
  CONFLUENCE_API_TOKEN: z.string().optional(),
  CONFLUENCE_BASE_URL: z.string().url().optional(),
  CONFLUENCE_SPACE_KEY: z.string().default('HOME'),
  CONFLUENCE_PROXY_MAX_BYTES: z.coerce.number().int().positive().default(200_000),

  // Odoo credentials. When set, the Odoo Accounting + HR sub-agents are enabled.
  ODOO_URL: z.string().url().optional(),
  ODOO_DB: z.string().optional(),
  ODOO_LOGIN: z.string().optional(),
  ODOO_API_KEY: z.string().optional(),
  ODOO_PROXY_MAX_BYTES: z.coerce.number().int().positive().default(500_000),
  // Opt-out of TLS verification for the Odoo connection only. Needed on
  // machines whose cert store doesn't include the ODOO_URL's CA (typical for
  // internal / private-CA-signed instances). Scoped to the Odoo client; does
  // NOT affect Anthropic or any other outgoing call.
  ODOO_INSECURE_TLS: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),

  // Diagram rendering (Kroki + Tigris/MinIO). When all required fields are
  // present, the orchestrator exposes `render_diagram` and the middleware
  // mounts the HMAC-signed image-proxy at /diagrams/<key>. Missing values
  // disable the feature cleanly — the rest of the middleware is unaffected.
  KROKI_BASE_URL: optionalNonEmpty(z.string().url()),
  DIAGRAM_URL_SECRET: optionalNonEmpty(z.string().min(32)),
  DIAGRAM_PUBLIC_BASE_URL: optionalNonEmpty(z.string().url()),
  DIAGRAM_SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(900),
  // Source-spec cap. Must accommodate base64-inlined brand assets (a 150 kB
  // PNG becomes ~200 kB base64), plus the normal Vega-Lite / Graphviz body.
  // Kroki's own POST-body limit is ~10 MB, so 1 MB is defensively low.
  DIAGRAM_MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(1_000_000),
  // Teams rejects card images > 1 MB; be strict and cap below that.
  DIAGRAM_MAX_PNG_BYTES: z.coerce.number().int().positive().default(900_000),

  // Object-storage (S3-compatible). Locally: MinIO from compose.yml. On Fly:
  // auto-populated by `fly storage create` (Tigris).
  BUCKET_NAME: z.string().optional(),
  AWS_ENDPOINT_URL_S3: optionalNonEmpty(z.string().url()),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // Off-site backup of the encrypted vault to the same Tigris bucket. The
  // backup only holds ciphertext — the master key (VAULT_KEY) is never
  // uploaded, so a bucket compromise alone cannot decrypt anything. Disabled
  // when BUCKET_NAME/AWS_* are missing regardless of this flag.
  VAULT_BACKUP_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  VAULT_BACKUP_PREFIX: z.string().min(1).default('backups/vault/'),
  VAULT_BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(30),
  VAULT_BACKUP_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(24),

  // Ollama sidecar for in-tenant embeddings (topic detection). When unset,
  // the Teams bot falls back to always-continue (current fire-and-use-full-
  // history behaviour); no hallucinated topic-asks on config drift.
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
  TOPIC_CLASSIFIER_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  TOPIC_UPPER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  TOPIC_LOWER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),

  // Odoo entity sync (proactive graph population). When enabled, the
  // middleware pulls res.partner, hr.employee, hr.department, account.journal
  // into the knowledge graph on startup and every INTERVAL hours thereafter.
  // Off by default — turn on once Odoo creds are stable to avoid a startup
  // spike that nobody signed up for.
  ODOO_ENTITY_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  ODOO_ENTITY_SYNC_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(6),
  ODOO_ENTITY_SYNC_PAGE_SIZE: z.coerce.number().int().positive().default(100),
  ODOO_ENTITY_SYNC_MAX_PER_MODEL: z.coerce.number().int().positive().default(5000),

  // Confluence entity sync (proactive graph population for pages).
  CONFLUENCE_ENTITY_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  CONFLUENCE_ENTITY_SYNC_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(12),
  CONFLUENCE_ENTITY_SYNC_PAGE_SIZE: z.coerce.number().int().positive().default(50),
  CONFLUENCE_ENTITY_SYNC_MAX_PAGES: z.coerce.number().int().positive().default(2000),

  // Graph-RAG embedding backfill. When a Turn's post-commit embed() call
  // fails (Ollama sidecar timeout / 500), the row stays in `graph_nodes`
  // with `embedding = NULL`, invisible to `searchTurnsByEmbedding`. This
  // scheduler re-tries those turns on a loop. Enabled by default whenever
  // OLLAMA_BASE_URL is set — the scheduler itself no-ops otherwise.
  GRAPH_EMBEDDING_BACKFILL_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
  GRAPH_EMBEDDING_BACKFILL_INTERVAL_MINUTES: z.coerce.number().min(1).max(360).default(5),
  GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(20),
  GRAPH_EMBEDDING_BACKFILL_MAX_ATTEMPTS: z.coerce.number().int().positive().max(50).default(5),
  // Cap parallel Ollama embedding requests. `nomic-embed-text` serialises
  // inference per request, so bursts (boot replay + backfill + live turns)
  // just produce timeouts if we let them all fly at once. 2 matches the
  // Ollama sidecar's 2 shared CPUs — bump if we upgrade the machine.
  GRAPH_EMBEDDING_MAX_CONCURRENT: z.coerce.number().int().min(0).max(32).default(2),

  // Teams attachment persistence. When enabled, incoming Teams message
  // attachments (files + inline images) are downloaded, stored in Tigris
  // under the `TEAMS_ATTACHMENT_KEY_PREFIX` prefix, and indexed in Neon
  // (`teams_attachments` — migration 0008). Pure storage; no text extraction
  // or graph ingest. Fires-and-forget on the Teams inbound path — never
  // blocks the bot reply.
  TEAMS_ATTACHMENT_STORAGE_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  TEAMS_ATTACHMENT_KEY_PREFIX: z.string().min(1).default('teams-attachments'),
  /** Per-file cap. Larger uploads are logged + skipped. */
  TEAMS_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(25_000_000),
  /**
   * HMAC secret for signed attachment URLs (`/attachments/<key>?sig=…`). Used
   * when the bot embeds a persisted logo/image URL into a Vega-Lite /
   * Graphviz / PlantUML diagram spec. Unset → the attachment proxy route
   * is NOT mounted (attachments still persist to Tigris, but can't be
   * served via signed URL).
   */
  ATTACHMENT_URL_SECRET: z.string().optional(),

  // Public OAuth-App client id for the in-app "Create Issue" button
  // (operator GitHub auth via the device flow — issues are filed as the
  // operator's own GitHub account). Optional ENV OVERRIDE of the client id
  // baked into the product (issues/githubOAuthProvider.ts). NO client
  // secret exists for this flow — the device grant needs only the (public)
  // client id, which is why omadia can ship the OAuth App included.
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  /** Public URL base for signed attachment URLs — typically the same as the
   *  diagram base URL (the Fly app's public origin). */
  ATTACHMENT_PUBLIC_BASE_URL: z.string().url().optional(),
  ATTACHMENT_SIGNED_URL_TTL_SEC: z
    .coerce.number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7), // 7 days — covers memory-based branding reuse across sessions

  // Answer verifier. When VERIFIER_ENABLED=true, every orchestrator reply is
  // classified by the trigger router and — if it carries numeric/ID/date
  // claims — re-checked against Odoo + knowledge-graph. VERIFIER_MODE picks
  // the blast radius:
  //   - shadow  : verifier runs + logs verdicts, never blocks or retries.
  //   - enforce : contradictions block the reply, trigger one retry with
  //               a correction prompt; final failure shows an honest error.
  // Leave OFF in production until the shadow-mode metrics are clean.
  VERIFIER_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  VERIFIER_MODE: z.enum(['shadow', 'enforce']).default('shadow'),
  VERIFIER_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  VERIFIER_MAX_CLAIMS: z.coerce.number().int().positive().default(20),
  VERIFIER_AMOUNT_TOLERANCE: z.coerce.number().nonnegative().default(0.01),
  VERIFIER_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),

  // Package upload (phases 1–5 of the zip-upload roadmap). Default OFF —
  // only flipped on once admin UI + security review are through.
  // Uploads land as an extracted folder under UPLOADED_PACKAGES_DIR and the
  // manifest is merged into the catalog. Secrets still go to the vault.
  PACKAGE_UPLOAD_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
  UPLOADED_PACKAGES_DIR: z.string().min(1).default('./.uploaded-packages'),
  PACKAGE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  PACKAGE_UPLOAD_MAX_EXTRACTED_BYTES: z.coerce.number().int().positive().default(80 * 1024 * 1024),
  PACKAGE_UPLOAD_MAX_ENTRIES: z.coerce.number().int().positive().default(2000),
  /** Base URL of the SkillSpector code-scan sidecar (issue #453), e.g.
   *  http://skillspector:8811. Unset → no scanning: ingests succeed
   *  unchanged and NO verdict rows are written (`scan_failed` is reserved
   *  for real sidecar failures). Advisory-only in v1 — a verdict never
   *  blocks an install. */
  SKILLSPECTOR_URL: z.string().url().optional(),
  SKILLSPECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Build identity, stamped into the image by publish-images.yml (#432).
   *  Unset ⇒ the build reports itself as `unknown` rather than guessing from
   *  package.json, which has been stale for the whole current release series.
   *  Deliberately NOT set by docker-compose.yaml: compose passing an empty
   *  value would override the value baked into the image. */
  OMADIA_VERSION: z.string().optional(),
  /** Base URL of the updater sidecar (#432), e.g. http://updater:8090. Unset
   *  ⇒ notify-only: the admin page still reports versions and flags a newer
   *  release, but cannot execute an update. Enabled by the opt-in overlay
   *  docker-compose.update.yaml. */
  OMADIA_UPDATER_URL: z.string().url().optional(),
  /** Shared bearer secret for the updater sidecar. Required whenever
   *  OMADIA_UPDATER_URL is set — see the cross-field check below. */
  OMADIA_UPDATER_TOKEN: z.string().min(16).optional(),
  /** `owner/repo` the release check queries. Override for a fork. */
  OMADIA_RELEASE_REPO: z.string().min(3).default('byte5ai/omadia'),
  /** Optional PAT for the release check — only needed for a private fork or
   *  a busy shared NAT (the unauthenticated GitHub budget is 60/h per IP). */
  OMADIA_RELEASE_TOKEN: z.string().optional(),
  /** Root of the built-in package tree (scanned for manifest.yaml files at
   *  boot). In dev this resolves to `<repo>/middleware/packages`; in the
   *  Docker image it's `/app/packages`. Each subdirectory with a valid
   *  schema-v1 manifest becomes an auto-installable plugin. */
  BUILT_IN_PACKAGES_DIR: z.string().min(1).default('./packages'),
  /** Optional dev-loop source for plugin authors iterating outside the
   *  workspace. When set to a directory, every sub-directory with a valid
   *  schema-v1 `manifest.yaml` is exposed as a plugin — same activation
   *  pathway as Built-In/Uploaded. Local-Dev wins on ID collision so an
   *  author can shadow a built-in or uploaded plugin without packing/
   *  zipping/uploading every iteration. Default is unset (disabled). */
  PLUGIN_DEV_DIR: z.string().optional(),

  // Remote plugin registries (the plugin "store"). JSON array of
  // {url,name,token?} entries — Core fetches each registry's `index.json`,
  // merges them (first-wins on id collision), and installs ZIPs through the
  // EXISTING upload pipeline. Empty/unset → no remote registry: OSS instances
  // run standalone and manual ZIP upload still works. `token`, when present,
  // is sent as `Authorization: Bearer` (how a private byte5/customer hub is
  // consumed). Example:
  //   REGISTRY_URLS='[{"name":"omadia-public","url":"https://hub.omadia.ai"}]'
  REGISTRY_URLS: z.string().optional(),
  REGISTRY_FETCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),

  // --- Public MCP endpoint (W2-3, issue #542) ------------------------------
  // omadia's own tools, exposed over a stateless Streamable-HTTP MCP server at
  // /api/v1/mcp to third parties holding an API key. This is the highest-blast
  // -radius surface in the MCP cluster — an internet-facing route that reaches
  // the tool layer, including WRITE tools by operator allowlist — so the whole
  // thing is dark by default: false mounts NO router at all, which is a
  // stronger guarantee than mounting one that answers 403.
  PUBLIC_MCP_ENABLED: devFlag(),
  // Whether tool calls are served when PII masking is unavailable.
  //
  // The dispatch privacy seam is closed — `ToolDispatchService` now replicates
  // the chat path's data-plane boundary — but it closed it at PARITY, which
  // includes two behaviours that are wrong for an untrusted caller: masking
  // fails OPEN on a provider error, and no installed privacy provider means
  // results pass through unchanged. The endpoint overrides both (see
  // `mcp/publicMcpPrivacy.ts`); this flag is the escape hatch for the coarsest
  // one — an install with no privacy provider at all.
  //
  // Default false ⇒ tools/list works, tools/call refuses and says why.
  // Set true ONLY on a deliberate, documented operator decision — e.g. an
  // install whose allowlisted tools provably carry no personal data.
  PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING: devFlag(),

  // --- Dev platform (epic #470 W0) ----------------------------------------
  // Isolated per-job code runners (clone → agent-edit → diff → server-side PR).
  // The whole subsystem is dark by default: DEV_PLATFORM_ENABLED=false mounts
  // no router and starts no worker. See src/devplatform/ and the wire unit.
  DEV_PLATFORM_ENABLED: devFlag(),
  // The W0 walking-skeleton LocalProcessBackend runs the agent under a dedicated
  // unprivileged uid with an allowlist-built env and NO dependency-install / test
  // execution. It is an unsafe skeleton by construction, so it stays off unless
  // the operator explicitly acknowledges it — and boot REFUSES the flag without a
  // uid (loadConfig, below), never runs the agent as root.
  DEV_PLATFORM_UNSAFE_LOCAL: devFlag(),
  DEV_PLATFORM_LOCAL_UID: optionalNonEmpty(z.coerce.number().int().positive()),
  DEV_PLATFORM_WORKSPACE_DIR: z
    .string()
    .min(1)
    .default(() => path.join(os.tmpdir(), 'omadia-dev-jobs')),
  // Where the runner phones home. Defaults to loopback + PORT in loadConfig.
  DEV_PLATFORM_RUNNER_BASE_URL: optionalNonEmpty(z.string().url()),
  // W2-2 (issue #543) — comma-separated sub-agent tool names (`ask_<slug>`) that
  // ALSO get the non-blocking `<name>_start`/`_status`/`_list` triple, so a slow
  // sub-agent stops blocking the chat turn it was delegated from. The blocking
  // `ask_<slug>` tool stays registered either way; empty (the default) means every
  // sub-agent keeps today's inline behaviour exactly.
  LONG_RUNNING_SUBAGENT_TOOLS: z.string().default(''),
  // Orphan windows for the long-running task seam: a live task silent this long
  // is failed as abandoned, and a finished task is retained this long so a
  // following turn can still collect its result.
  LONG_RUNNING_TASK_STALE_MS: z.coerce.number().int().positive().default(900_000),
  LONG_RUNNING_TASK_RETAIN_MS: z.coerce.number().int().positive().default(3_600_000),
  DEV_PLATFORM_CLI_BIN: z.string().min(1).default('claude'),
  DEV_PLATFORM_JOB_WALL_CLOCK_MS: z.coerce.number().int().positive().default(1_800_000),
  DEV_PLATFORM_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DEV_PLATFORM_MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(1),
  DEV_PLATFORM_GITHUB_CLIENT_ID: optionalNonEmpty(z.string().min(1)),
  DEV_PLATFORM_COMMIT_AUTHOR: z.string().min(1).default('omadia-dev <dev-platform@omadia.ai>'),
  DEV_PLATFORM_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Epic #470 W5 — data lifecycle (spec §7). Two-tier event retention: low-value
  // telemetry (heartbeat/log) is pruned at EVENT_RETENTION_DAYS above; audit-grade
  // events (status/tool/gate/token/approval/egress/phase) are kept until this outer
  // bound. The daily retention job also purges terminal jobs older than it.
  DEV_PLATFORM_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  // Per-job event cap: once a job holds this many events, the append path drops
  // further low-value telemetry (keeps audit-grade events) and records one
  // `events_truncated` status event. Bounds a runaway agent's event stream.
  DEV_JOB_MAX_EVENTS: z.coerce.number().int().positive().default(50_000),
  // Artifact ceiling: inline content larger than this is offloaded to object
  // storage (when wired) or marked and refused inline (default 5 MiB).
  DEV_ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  // Q4 decision: subscription-mode jobs run the CLI on the operator's Claude
  // login, so the credential is IN the runner. It is off by default and boot
  // REFUSES the flag unless the operator also sets the explicit acknowledgment
  // string (loadConfig, below) — a boot-time refusal, not a warning.
  DEV_PLATFORM_SUBSCRIPTION_MODE: devFlag(),
  DEV_PLATFORM_SUBSCRIPTION_ACK: optionalNonEmpty(z.string().min(1)),
  // --- W1 keystones (spec §4/§6/§6b) ---------------------------------------
  // The daemon's shared bearer for the internal job-policy endpoint AND the
  // DockerBackend's control-plane calls. Absent ⇒ the job-policy endpoint 503s
  // and the DockerBackend is NOT registered.
  DEV_RUNNER_DAEMON_TOKEN: optionalNonEmpty(z.string().min(1)),
  // The daemon control-plane origin the middleware calls (spec §4/§5). Absent ⇒
  // the DockerBackend is not registered even under DEV_PLATFORM_BACKEND=docker.
  DEV_RUNNER_DAEMON_URL: optionalNonEmpty(z.string().url()),
  // Which runner backend the operator ships (spec §5): `docker` registers the
  // container backend as the shipping path; `local` keeps the W0 skeleton (which
  // ALSO requires DEV_PLATFORM_UNSAFE_LOCAL). Default `docker` — the local
  // backend never becomes the permanent crutch the epic warns against, and it
  // stays inert until its own acknowledgment flag is set anyway.
  DEV_PLATFORM_BACKEND: z.enum(['docker', 'local']).default('docker'),
  // Lease TTL a docker job requests + renews at ~TTL/3 (spec §7/§8). Bounded to
  // the daemon's [30, 3600] window in the backend.
  DEV_JOB_LEASE_TTL_SEC: z.coerce.number().int().positive().default(180),
  // Digest-pinned runner image. Absent ⇒ the job-policy endpoint 503s.
  DEV_RUNNER_DEFAULT_IMAGE: optionalNonEmpty(z.string().min(1)),
  // Operator egress default, comma-separated bare hostnames (validated in
  // deriveJobPolicy). Absent ⇒ empty base allowlist.
  DEV_EGRESS_BASE_ALLOWLIST: optionalNonEmpty(z.string().min(1)),
  // Hostname the job container reaches the middleware on; defaults to the
  // RUNNER_BASE_URL host in the wire layer when unset.
  DEV_PLATFORM_MIDDLEWARE_HOST: optionalNonEmpty(z.string().min(1)),
  // LLM proxy (spec §6b): upstream origin + exact model allowlist. The proxy is
  // always mounted; an empty allowlist ⇒ it answers 500 "no LLM policy".
  DEV_PLATFORM_LLM_UPSTREAM_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  DEV_PLATFORM_LLM_PROVIDER: z.string().min(1).default('anthropic'),
  DEV_PLATFORM_LLM_ALLOWED_MODELS: optionalNonEmpty(z.string().min(1)),

  // Epic #470 W4 — LLM budget hard-enforcement ceiling (spec §5, Forge W4 #2).
  // The proxy clamps a job's `max_tokens` to this so the buffered enforcement path
  // can never overshoot the budget by an unbounded single response.
  DEV_JOB_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),

  // Epic #470 W4 — FlyMachinesBackend (spec §2): one ephemeral Fly Machine per job
  // in a DEDICATED runner app (NEVER odoo-bot-middleware). The backend is registered
  // ONLY when DEV_FLY_RUNNER_APP is set (absent ⇒ not registered, like the docker
  // backend keys on the daemon url). The operator MUST have run
  // `flyctl apps create <app> --org <org>` and stored a deploy token in Vault at
  // `core:dev-platform` key `fly/deploy_token` — the wiring logs a hint at boot.
  DEV_FLY_RUNNER_APP: optionalNonEmpty(z.string().min(1)),
  // Fly-injected env; presence is the on-Fly detector (picks the internal Machines
  // API + `.internal` phone-home address). Absent off-Fly ⇒ public endpoints.
  FLY_APP_NAME: optionalNonEmpty(z.string().min(1)),
  // Digest-pinned runner image for Fly machines. Falls back to
  // DEV_RUNNER_DEFAULT_IMAGE when unset (both must be digest-pinned, never a tag).
  DEV_RUNNER_IMAGE: optionalNonEmpty(z.string().min(1)),
  // Operator override for the shim phone-home URL. Default: on-Fly
  // `http://$FLY_APP_NAME.internal:8080`, else PUBLIC_BASE_URL.
  DEV_FLY_PHONE_HOME_URL: optionalNonEmpty(z.string().min(1)),
  // Guest ceilings — a per-job request over these is CLAMPED, never honored.
  DEV_FLY_MAX_CPUS: z.coerce.number().int().positive().default(4),
  DEV_FLY_MAX_MEMORY_MB: z.coerce.number().int().positive().default(8192),
  // Default guest size a Fly machine boots with (clamped to the ceilings above).
  DEV_FLY_GUEST_CPUS: z.coerce.number().int().positive().default(1),
  DEV_FLY_GUEST_MEMORY_MB: z.coerce.number().int().positive().default(1024),
  // Optional Fly region placement (Fly picks one when unset).
  DEV_FLY_REGION: optionalNonEmpty(z.string().min(1)),
});

/**
 * Schema keys that begin `DEV_`/`FLY_` but are core, NOT dev-platform. Everything
 * else with those prefixes is collapsed out of the top-level `Config` and served
 * only through `config.devPlatform` (epic #470 C3).
 *
 *   - `DEV_ENDPOINTS_ENABLED` — the core dev-graph endpoints (`/api/dev/*`).
 *   - `DEV_ENDPOINTS_LOOPBACK_ONLY` — the #669 address gate over the same surface.
 *   - `FLY_APP_NAME`          — Fly-injected identity of THIS app. The dev platform
 *                               reads its value (copied into `devPlatform.fly`),
 *                               but the key describes the host, not the feature, so
 *                               it must survive the extraction.
 *
 * A third lookalike needs no entry here because it does not carry either prefix:
 * `PLUGIN_DEV_DIR`, the plugin author's local-dev source directory.
 *
 * Stating the EXCEPTIONS rather than enumerating the 40 members is deliberate: a
 * new `DEV_PLATFORM_*` key added to the schema lands in the namespace on its own,
 * with no second list to forget. A new *core* key with those prefixes must be
 * added here — and that is the change that deserves the review attention.
 */
const CORE_DEV_PREFIXED_KEYS = [
  'DEV_ENDPOINTS_ENABLED',
  'DEV_ENDPOINTS_LOOPBACK_ONLY',
  'FLY_APP_NAME',
] as const;
type CoreDevPrefixedKey = (typeof CORE_DEV_PREFIXED_KEYS)[number];

type ParsedConfig = z.infer<typeof ConfigSchema>;

/** Every schema key the dev platform owns: prefix-matched, minus the exceptions. */
type DevPlatformEnvKey = Exclude<
  Extract<keyof ParsedConfig, `DEV_${string}` | `FLY_${string}`>,
  CoreDevPrefixedKey
>;

/** Runtime half of `DevPlatformEnvKey` — same rule, applied to actual key strings. */
function isDevPlatformEnvKey(key: string): boolean {
  if ((CORE_DEV_PREFIXED_KEYS as readonly string[]).includes(key)) return false;
  return key.startsWith('DEV_') || key.startsWith('FLY_');
}

/**
 * The core config: everything the schema parses EXCEPT the dev-platform keys,
 * which are reachable only via `config.devPlatform`. Collapsing them out of the
 * top level is what makes the later extraction mechanical — when the subsystem
 * leaves, one property and one builder disappear instead of 40 call sites.
 */
export type Config = Omit<ParsedConfig, DevPlatformEnvKey> & {
  devPlatform: DevPlatformConfig;
};

/** Comma-separated env list → trimmed non-empty entries (egress allowlist, model
 *  allowlist). Entry-level validation happens in the consumer (deriveJobPolicy). */
function csvList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the dev-platform namespace from the parsed env. The ONLY place that maps
 * `DEV_*`/`FLY_*` env names onto the subsystem's own vocabulary — everything
 * downstream takes the object. Post-processing that used to be scattered lives
 * here: the runner base-URL default from `PORT`, `resolvePath` on the workspace
 * dir, the `DEV_RUNNER_IMAGE ?? DEV_RUNNER_DEFAULT_IMAGE` fallback, the
 * `DEV_PLATFORM_GITHUB_CLIENT_ID ?? GITHUB_OAUTH_CLIENT_ID` fallback, and the two
 * comma-separated list splits.
 */
function buildDevPlatformConfig(parsed: ParsedConfig): DevPlatformConfig {
  return {
    enabled: parsed.DEV_PLATFORM_ENABLED,
    // Runner phone-home base URL: explicit override, else loopback + PORT.
    baseUrl:
      parsed.DEV_PLATFORM_RUNNER_BASE_URL ?? `http://127.0.0.1:${String(parsed.PORT)}`,
    cliBin: parsed.DEV_PLATFORM_CLI_BIN,
    wallClockMs: parsed.DEV_PLATFORM_JOB_WALL_CLOCK_MS,
    heartbeatTimeoutMs: parsed.DEV_PLATFORM_HEARTBEAT_TIMEOUT_MS,
    maxConcurrentJobs: parsed.DEV_PLATFORM_MAX_CONCURRENT_JOBS,
    commitAuthor: parsed.DEV_PLATFORM_COMMIT_AUTHOR,
    subscriptionModeEnabled: parsed.DEV_PLATFORM_SUBSCRIPTION_MODE,
    subscriptionAck: parsed.DEV_PLATFORM_SUBSCRIPTION_ACK,
    workspaceDir: resolvePath(parsed.DEV_PLATFORM_WORKSPACE_DIR),
    unsafeLocal: parsed.DEV_PLATFORM_UNSAFE_LOCAL,
    localUid: parsed.DEV_PLATFORM_LOCAL_UID,
    githubClientId: parsed.DEV_PLATFORM_GITHUB_CLIENT_ID ?? parsed.GITHUB_OAUTH_CLIENT_ID,
    daemonToken: parsed.DEV_RUNNER_DAEMON_TOKEN,
    daemonUrl: parsed.DEV_RUNNER_DAEMON_URL,
    backend: parsed.DEV_PLATFORM_BACKEND,
    leaseTtlSec: parsed.DEV_JOB_LEASE_TTL_SEC,
    // `DEV_RUNNER_IMAGE` wins when set (the daemon's own allowlist config uses
    // that name too, so one operator-set var keeps every side in agreement);
    // `DEV_RUNNER_DEFAULT_IMAGE` is the fallback.
    runnerImage: parsed.DEV_RUNNER_IMAGE ?? parsed.DEV_RUNNER_DEFAULT_IMAGE,
    egressBaseAllowlist: parsed.DEV_EGRESS_BASE_ALLOWLIST
      ? csvList(parsed.DEV_EGRESS_BASE_ALLOWLIST)
      : undefined,
    middlewareHost: parsed.DEV_PLATFORM_MIDDLEWARE_HOST,
    llm: {
      provider: parsed.DEV_PLATFORM_LLM_PROVIDER,
      upstreamBaseUrl: parsed.DEV_PLATFORM_LLM_UPSTREAM_BASE_URL,
      allowedModels: parsed.DEV_PLATFORM_LLM_ALLOWED_MODELS
        ? csvList(parsed.DEV_PLATFORM_LLM_ALLOWED_MODELS)
        : [],
      defaultBudgetCostUsd: parsed.DEV_JOB_DEFAULT_BUDGET_USD,
      maxOutputTokens: parsed.DEV_JOB_MAX_OUTPUT_TOKENS,
    },
    fly: {
      runnerApp: parsed.DEV_FLY_RUNNER_APP,
      hostAppName: parsed.FLY_APP_NAME,
      phoneHomeUrl: parsed.DEV_FLY_PHONE_HOME_URL,
      publicBaseUrl: parsed.PUBLIC_BASE_URL,
      maxCpus: parsed.DEV_FLY_MAX_CPUS,
      maxMemoryMb: parsed.DEV_FLY_MAX_MEMORY_MB,
      guestCpus: parsed.DEV_FLY_GUEST_CPUS,
      guestMemoryMb: parsed.DEV_FLY_GUEST_MEMORY_MB,
      region: parsed.DEV_FLY_REGION,
    },
    webhooks: {
      enabled: parsed.DEV_WEBHOOKS_ENABLED,
      maxJobsPerRepoHour: parsed.DEV_WEBHOOK_MAX_JOBS_PER_REPO_HOUR,
      maxJobsPerSenderHour: parsed.DEV_WEBHOOK_MAX_JOBS_PER_SENDER_HOUR,
    },
    retention: {
      eventRetentionDays: parsed.DEV_PLATFORM_EVENT_RETENTION_DAYS,
      auditRetentionDays: parsed.DEV_PLATFORM_AUDIT_RETENTION_DAYS,
      maxEventsPerJob: parsed.DEV_JOB_MAX_EVENTS,
      artifactMaxBytes: parsed.DEV_ARTIFACT_MAX_BYTES,
    },
  };
}

// Relative path-like settings are resolved against the middleware root so the server
// works regardless of the CWD (local dev, Docker, Fly machine, tests).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const middlewareRoot = path.resolve(moduleDir, '..');

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(middlewareRoot, value);
}

/**
 * Resolve a WRITABLE persistent-state dir (memory store, uploaded plugin
 * packages). Precedence:
 *   1. explicit env override → honour it verbatim (resolvePath).
 *   2. else, when `PLATFORM_DATA_DIR` is set → default UNDER it, so the single
 *      data volume captures this state alongside the vault + installed.json +
 *      builder drafts (see platform/paths.ts `DATA_DIR`). Without this the dir
 *      defaulted under the image layer (`/app/.memory`, `/app/.uploaded-
 *      packages`) and was wiped on every `docker compose up --build` — leaving
 *      installed.json (on the volume) pointing at packages that no longer
 *      exist, so locally-installed plugins silently stop loading while their
 *      settings persist. The compose comment already promises this behaviour.
 *   3. else (local dev, no PLATFORM_DATA_DIR) → legacy app-root default.
 */
export function resolveStateDir(
  envKey: string,
  zodDefaultResolved: string,
  leaf: string,
): string {
  const explicit = process.env[envKey];
  if (explicit && explicit.trim() !== '') return resolvePath(explicit);
  const platformDataDir = process.env['PLATFORM_DATA_DIR']?.trim();
  if (platformDataDir) return path.join(path.resolve(platformDataDir), leaf);
  return resolvePath(zodDefaultResolved);
}

/**
 * Boot-time refusals for the dev platform's two credential-exposing modes
 * (epic #470 W0). These are hard refusals, NOT warnings: an operator who turns
 * on subscription mode or the unsafe local backend without the paired safety
 * variable must not boot. Pure + exported so the wire unit's test can drive it
 * without importing the whole config module.
 */
export function devPlatformBootRefusals(cfg: {
  subscriptionMode: boolean;
  subscriptionAck: string | undefined;
  unsafeLocal: boolean;
  localUid: number | undefined;
}): string[] {
  const refusals: string[] = [];
  if (cfg.subscriptionMode && !cfg.subscriptionAck) {
    refusals.push(
      'DEV_PLATFORM_SUBSCRIPTION_MODE=true requires DEV_PLATFORM_SUBSCRIPTION_ACK to be set ' +
        '(the operator must acknowledge that subscription jobs run the CLI credential inside the runner)',
    );
  }
  if (cfg.unsafeLocal && cfg.localUid === undefined) {
    refusals.push(
      'DEV_PLATFORM_UNSAFE_LOCAL=true requires DEV_PLATFORM_LOCAL_UID ' +
        '(the jailed shim must run as a dedicated unprivileged uid, never root)',
    );
  }
  return refusals;
}

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const refusals = devPlatformBootRefusals({
    subscriptionMode: parsed.data.DEV_PLATFORM_SUBSCRIPTION_MODE,
    subscriptionAck: parsed.data.DEV_PLATFORM_SUBSCRIPTION_ACK,
    unsafeLocal: parsed.data.DEV_PLATFORM_UNSAFE_LOCAL,
    localUid: parsed.data.DEV_PLATFORM_LOCAL_UID,
  });
  if (refusals.length > 0) {
    throw new Error(`Invalid configuration:\n${refusals.map((r) => `  - ${r}`).join('\n')}`);
  }
  // #432 — an updater URL without its shared secret would leave the kernel
  // calling an endpoint that can replace every container in the stack with no
  // credential. Refuse at boot rather than fail at the one moment an operator
  // is trying to update.
  if (
    parsed.data.OMADIA_UPDATER_URL !== undefined &&
    (parsed.data.OMADIA_UPDATER_TOKEN ?? '').length === 0
  ) {
    throw new Error(
      'Invalid configuration:\n  - OMADIA_UPDATER_TOKEN: required whenever OMADIA_UPDATER_URL is set',
    );
  }
  // The dev-platform keys are lifted out of the top level and served only through
  // `devPlatform`. Deleting them from the returned object (rather than merely
  // hiding them in the type) means there is no second, stale way to read them.
  const core: Record<string, unknown> = { ...parsed.data };
  for (const key of Object.keys(core)) {
    if (isDevPlatformEnvKey(key)) delete core[key];
  }

  return {
    ...(core as Omit<ParsedConfig, DevPlatformEnvKey>),
    MEMORY_SEED_DIR: resolvePath(parsed.data.MEMORY_SEED_DIR),
    SKILLS_DIR: resolvePath(parsed.data.SKILLS_DIR),
    UPLOADED_PACKAGES_DIR: resolveStateDir(
      'UPLOADED_PACKAGES_DIR',
      parsed.data.UPLOADED_PACKAGES_DIR,
      '.uploaded-packages',
    ),
    PLUGIN_DEV_DIR: parsed.data.PLUGIN_DEV_DIR
      ? resolvePath(parsed.data.PLUGIN_DEV_DIR)
      : undefined,
    devPlatform: buildDevPlatformConfig(parsed.data),
  };
}

export const config: Config = loadConfig();

/**
 * Parse `REGISTRY_URLS` into a validated list of registry config entries.
 * Defensive by design: malformed JSON or invalid entries are logged and
 * dropped rather than crashing boot — a misconfigured registry must never
 * take the whole middleware down, it just means "no remote store".
 * Exported standalone so it is unit-testable without booting the server.
 */
export function parseRegistries(
  raw: string | undefined,
  log: (msg: string) => void = (m) => console.warn(m),
): RegistryConfigEntry[] {
  if (!raw || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log(
      `[config] REGISTRY_URLS is not valid JSON — ignoring (no remote registry): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    log('[config] REGISTRY_URLS must be a JSON array — ignoring.');
    return [];
  }
  const out: RegistryConfigEntry[] = [];
  const seenNames = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec['url'] === 'string' ? rec['url'].trim() : '';
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    if (!url || !name) {
      log('[config] REGISTRY_URLS entry missing url/name — skipped.');
      continue;
    }
    try {
       
      new URL(url);
    } catch {
      log(`[config] REGISTRY_URLS entry '${name}' has a malformed url — skipped.`);
      continue;
    }
    if (seenNames.has(name)) {
      log(`[config] REGISTRY_URLS duplicate name '${name}' — skipped.`);
      continue;
    }
    seenNames.add(name);
    const entry: RegistryConfigEntry = { url, name };
    if (typeof rec['token'] === 'string' && rec['token']) {
      entry.token = rec['token'];
    }
    out.push(entry);
  }
  return out;
}
