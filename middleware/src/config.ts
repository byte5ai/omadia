import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

import type { RegistryConfigEntry } from './api/registry-v1.js';

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

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3979),

  // Anthropic SDK — optional since OB-61: the operator can supply the key
  // through the /setup wizard on first boot (vault-stored per plugin), so
  // an empty ENV is now a valid state. When unset AND the vault has no key
  // either, the orchestrator + verifier + orchestrator-extras plugins
  // register but their LLM-bound capabilities stay unpublished until the
  // operator runs /setup or PATCHes a key via /api/v1/admin/runtime/secrets.
  ANTHROPIC_API_KEY: z.string().optional(),
  ORCHESTRATOR_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ORCHESTRATOR_MAX_TOKENS: z.coerce.number().int().positive().default(8192),

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

  // Memory persistence (filesystem backend for now)
  MEMORY_DIR: z.string().min(1).default('./.memory'),
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

  // Local-dev endpoints (unauthenticated memory browser, …). Keep this OFF in
  // any deployed environment — the router mounts under /api/dev and exposes
  // raw memory contents without auth. Only enable when iterating on the
  // Next.js dev UI against a local middleware.
  DEV_ENDPOINTS_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),

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
});

export type Config = z.infer<typeof ConfigSchema>;

// Relative path-like settings are resolved against the middleware root so the server
// works regardless of the CWD (local dev, Docker, Fly machine, tests).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const middlewareRoot = path.resolve(moduleDir, '..');

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(middlewareRoot, value);
}

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return {
    ...parsed.data,
    MEMORY_DIR: resolvePath(parsed.data.MEMORY_DIR),
    MEMORY_SEED_DIR: resolvePath(parsed.data.MEMORY_SEED_DIR),
    SKILLS_DIR: resolvePath(parsed.data.SKILLS_DIR),
    UPLOADED_PACKAGES_DIR: resolvePath(parsed.data.UPLOADED_PACKAGES_DIR),
    PLUGIN_DEV_DIR: parsed.data.PLUGIN_DEV_DIR
      ? resolvePath(parsed.data.PLUGIN_DEV_DIR)
      : undefined,
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
