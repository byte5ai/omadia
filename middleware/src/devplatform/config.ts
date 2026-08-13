/**
 * Epic #470 — the dev-platform's own configuration namespace.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Core's `src/config.ts` owns the zod schema that reads `process.env` — that does
 * not change, and it stays in core when the dev platform is extracted. What used
 * to be spread across `index.ts` was the *shape*: ~20 individual `config.DEV_*`
 * values threaded one by one into `assembleDevPlatform`, plus a handful of
 * derivations (comma-separated list splitting, the runner-image fallback, the
 * GitHub client-id fallback) done inline at the call site.
 *
 * This interface is the single argument the assembly takes instead. Core builds
 * one of these in `config.ts` (`config.devPlatform`) and hands it over; nothing
 * outside the boundary needs to know an env-var name again. When the subsystem
 * moves to a plugin, the plugin brings this contract with it and core deletes
 * exactly one builder function.
 *
 * OPTIONALITY IS DELIBERATE and mirrors what `assembleDevPlatform` already did
 * with its individual fields: an optional field keeps the assembly's own `??`
 * fallback, so a test that omits it behaves exactly as it did before this shape
 * existed. Fields the real boot always supplies (because zod gives them a
 * default) are required.
 */

/** Guest sizing for a Fly machine, before the ceilings are applied. */
export interface DevPlatformFlyConfig {
  /** `DEV_FLY_RUNNER_APP` — the DEDICATED runner app. Absent ⇒ the Fly backend is
   *  not registered at all. NEVER the middleware's own app (refused at assembly). */
  runnerApp?: string | undefined;
  /** `FLY_APP_NAME` — Fly-injected, core-owned. Copied in here because its
   *  PRESENCE is the on-/off-Fly detector (internal Machines API + `.internal`
   *  phone-home) and its VALUE is what the dedicated-app refusal compares against. */
  hostAppName?: string | undefined;
  /** `DEV_FLY_PHONE_HOME_URL` — operator override for the shim phone-home URL. */
  phoneHomeUrl?: string | undefined;
  /** `PUBLIC_BASE_URL` — core-owned; the off-Fly phone-home fallback. */
  publicBaseUrl?: string | undefined;
  /** `DEV_FLY_MAX_CPUS` ceiling (a per-job request above it is clamped). */
  maxCpus?: number | undefined;
  /** `DEV_FLY_MAX_MEMORY_MB` ceiling. */
  maxMemoryMb?: number | undefined;
  /** `DEV_FLY_GUEST_CPUS` — default guest size. */
  guestCpus?: number | undefined;
  /** `DEV_FLY_GUEST_MEMORY_MB` — default guest size. */
  guestMemoryMb?: number | undefined;
  /** `DEV_FLY_REGION` — optional placement (Fly picks one when unset). */
  region?: string | undefined;
}

/** LLM-proxy policy (spec §6b). */
export interface DevPlatformLlmConfig {
  /** `DEV_PLATFORM_LLM_PROVIDER` — vault provider segment. */
  provider?: string | undefined;
  /** `DEV_PLATFORM_LLM_UPSTREAM_BASE_URL`. */
  upstreamBaseUrl?: string | undefined;
  /** `DEV_PLATFORM_LLM_ALLOWED_MODELS`, already split. Empty ⇒ the proxy 500s. */
  allowedModels?: readonly string[] | undefined;
  /** `DEV_JOB_DEFAULT_BUDGET_USD`. */
  defaultBudgetCostUsd?: number | undefined;
  /** `DEV_JOB_MAX_OUTPUT_TOKENS` — the `max_tokens` clamp ceiling. */
  maxOutputTokens?: number | undefined;
}

/** GitHub webhook trigger controls (spec §3). Read by the mount site, not the assembly. */
export interface DevPlatformWebhooksConfig {
  /** `DEV_WEBHOOKS_ENABLED` — global kill switch. */
  enabled: boolean;
  /** `DEV_WEBHOOK_MAX_JOBS_PER_REPO_HOUR`. */
  maxJobsPerRepoHour: number;
  /** `DEV_WEBHOOK_MAX_JOBS_PER_SENDER_HOUR`. */
  maxJobsPerSenderHour: number;
}

/** Data-lifecycle bounds (spec §7). Read by the retention cron + the job store. */
export interface DevPlatformRetentionConfig {
  /** `DEV_PLATFORM_EVENT_RETENTION_DAYS` — low-value telemetry prune age. */
  eventRetentionDays: number;
  /** `DEV_PLATFORM_AUDIT_RETENTION_DAYS` — audit-grade outer bound. */
  auditRetentionDays: number;
  /** `DEV_JOB_MAX_EVENTS` — per-job event cap. */
  maxEventsPerJob: number;
  /** `DEV_ARTIFACT_MAX_BYTES` — inline artifact ceiling. */
  artifactMaxBytes: number;
}

/**
 * Everything the dev platform is configured by, in one namespace.
 * Every field names the env var it comes from; core's `config.ts` is the only
 * place that reads those names.
 */
export interface DevPlatformConfig {
  /** `DEV_PLATFORM_ENABLED` — dark by default; false mounts nothing. */
  enabled: boolean;
  /** `DEV_PLATFORM_RUNNER_BASE_URL`, already defaulted to loopback + `PORT`. */
  baseUrl: string;
  /** `DEV_PLATFORM_CLI_BIN`. */
  cliBin: string;
  /** `DEV_PLATFORM_JOB_WALL_CLOCK_MS`. */
  wallClockMs: number;
  /** `DEV_PLATFORM_HEARTBEAT_TIMEOUT_MS`. */
  heartbeatTimeoutMs: number;
  /** `DEV_PLATFORM_MAX_CONCURRENT_JOBS`. */
  maxConcurrentJobs: number;
  /** `DEV_PLATFORM_COMMIT_AUTHOR` — `Name <email>`. */
  commitAuthor: string;
  /** `DEV_PLATFORM_SUBSCRIPTION_MODE`. */
  subscriptionModeEnabled: boolean;
  /** `DEV_PLATFORM_SUBSCRIPTION_ACK` — the paired acknowledgment the boot refusal
   *  demands. Carried here so the whole namespace is one object; only the refusal
   *  reads it. */
  subscriptionAck?: string | undefined;
  /** `DEV_PLATFORM_WORKSPACE_DIR`, already run through `resolvePath`. */
  workspaceDir: string;
  /** `DEV_PLATFORM_UNSAFE_LOCAL`. */
  unsafeLocal: boolean;
  /** `DEV_PLATFORM_LOCAL_UID` — required by the refusal whenever `unsafeLocal`. */
  localUid?: number | undefined;
  /** `DEV_PLATFORM_GITHUB_CLIENT_ID`, falling back to `GITHUB_OAUTH_CLIENT_ID`. */
  githubClientId?: string | undefined;
  /** `DEV_RUNNER_DAEMON_TOKEN`. Absent ⇒ job-policy endpoint 503s, no DockerBackend. */
  daemonToken?: string | undefined;
  /** `DEV_RUNNER_DAEMON_URL`. Absent ⇒ no DockerBackend. */
  daemonUrl?: string | undefined;
  /** `DEV_PLATFORM_BACKEND` — which runner backend ships. Always present (the
   *  schema defaults it to `docker`), so consumers never re-default it. */
  backend: 'docker' | 'local';
  /** `DEV_JOB_LEASE_TTL_SEC`. */
  leaseTtlSec?: number | undefined;
  /** `DEV_RUNNER_IMAGE`, falling back to `DEV_RUNNER_DEFAULT_IMAGE`. Absent ⇒ the
   *  job-policy endpoint 503s and the Fly backend is not registered. */
  runnerImage?: string | undefined;
  /** `DEV_EGRESS_BASE_ALLOWLIST`, already split on commas. */
  egressBaseAllowlist?: readonly string[] | undefined;
  /** `DEV_PLATFORM_MIDDLEWARE_HOST`. Absent ⇒ derived from `baseUrl`. */
  middlewareHost?: string | undefined;
  llm?: DevPlatformLlmConfig | undefined;
  fly?: DevPlatformFlyConfig | undefined;
  webhooks: DevPlatformWebhooksConfig;
  retention: DevPlatformRetentionConfig;
}
