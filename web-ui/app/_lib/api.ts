import type {
  AuditMode,
  InstallChainResolution,
  InstallConfigureResponse,
  InstallCreateResponse,
  InstallJob,
  ListUploadedPackagesResponse,
  StoreGetResponse,
  StoreListResponse,
  UploadPackageResponse,
} from './storeTypes';
import type { PersonaConfig } from './personaTypes';
import type {
  ImportBundleSuccess,
  ProfileApplyOutcome,
  ProfileDetail,
  ProfileListResponse,
} from './profileTypes';
import type {
  CaptureSnapshotBody,
  CaptureSnapshotResponse,
  DiffResponse,
  DiffSideRef,
  ListSnapshotsResponse,
  RollbackResponse,
  SnapshotSummary,
} from './snapshotTypes';
import type {
  BuilderModelId,
  BuilderTurnEvent,
  CloneFromInstalledResponse,
  DraftEnvelope,
  DraftLibsResponse,
  DraftListScope,
  InstallResponse,
  JsonPatch,
  ListBuilderModelsResponse,
  ListBuilderTemplatesResponse,
  ListDraftsResponse,
  PreviewStreamEvent,
  TemplateSlotsResponse,
} from './builderTypes';

/**
 * API client for the Harness Admin API v1.
 *
 * Two call paths, both same-origin from the respective callers:
 *
 * - Browser: relative /bot-api/* — Next rewrites to the middleware (see
 *   next.config.ts). No CORS, no env var leakage to the client bundle.
 * - Server Components / Route Handlers: direct hit against MIDDLEWARE_URL
 *   (default http://localhost:3979). Avoids double-proxying through our
 *   own Next server and decouples RSC fetches from the Next dev port.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') {
    return `/bot-api${path}`;
  }
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

/**
 * Attach the incoming browser session cookie when this call is happening
 * inside a React Server Component on the Next.js server. The middleware
 * guards /api/v1/* with a cookie-based JWT, so an RSC fetch without the
 * cookie would always 401 even though the user is authenticated in the
 * browser. Imported dynamically so this file stays usable from the client
 * bundle (`next/headers` throws if imported from a client component).
 */
async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const all = jar.getAll();
    if (all.length === 0) return {};
    const serialized = all.map((c) => `${c.name}=${c.value}`).join('; ');
    return { cookie: serialized };
  } catch {
    // Outside an RSC request (e.g. unit tests) — nothing to forward.
    return {};
  }
}

/**
 * Browser-side bounce-to-login on 401 ONLY. The edge middleware handles
 * missing/expired cookies up-front, but if a cookie has a future `exp`
 * with a signature the backend rejects (key rotation, claims mismatch),
 * the middleware passes through and the API call surfaces 401 — at that
 * point we navigate the browser to /login so the user can recover
 * instead of staring at a "FEHLER" card.
 *
 * 403 is NOT bounced here. Per HTTP semantics, 403 means "authenticated
 * but forbidden" — the cookie is fine, the user just lacks permission
 * for this specific resource (e.g. non-owner reading a memory's audit,
 * non-admin hitting an admin endpoint). Bouncing those to /login would
 * mask the actual ACL violation as a session issue, log the user out
 * unnecessarily, and trigger a redirect loop after the user re-logs in.
 * Callers must surface 403s in-page (the page-level catch blocks already
 * do — they render the error code without further redirect).
 *
 * Skip when already on /login or /setup to avoid loops. Skip on the
 * server too — server-side 401s are handled by `redirectIfUnauthorized`
 * inside RSC catch-blocks, which uses Next's `redirect()`.
 */
function maybeNavigateToLogin(status: number): void {
  if (typeof window === 'undefined') return;
  if (status !== 401) return;
  const { pathname } = window.location;
  if (pathname === '/login' || pathname === '/setup') return;
  const returnPath = pathname + window.location.search;
  window.location.assign(`/login?return=${encodeURIComponent(returnPath)}`);
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(path), {
    ...init,
    headers: {
      accept: 'application/json',
      ...forwarded,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    maybeNavigateToLogin(res.status);
    throw new ApiError(res.status, `GET ${path} failed: ${res.status}`, text);
  }
  return (await res.json()) as T;
}

async function postJson<T>(
  path: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(path), {
    ...init,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
      ...(init?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'include',
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    maybeNavigateToLogin(res.status);
    throw new ApiError(res.status, `POST ${path} failed: ${res.status}`, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: string = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// -----------------------------------------------------------------------------
// NDJSON helper — yields parsed JSON objects from a `application/x-ndjson`
// stream. Tolerates LF and CRLF line endings, ignores blank lines, and
// surfaces JSON parse errors with line context so the caller can decide to
// abort or skip the malformed event. Used by streamBuilderTurn (B.5-2) and
// will be reused by streamPreviewTurn (B.5-7) and the SSE event-bus consumer
// (B.5-4).
// -----------------------------------------------------------------------------

async function* parseNdjsonLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) {
        const tail = buffer.trim();
        if (tail.length > 0) yield safeJsonParse(tail);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let lineStart = 0;
      let lineEnd = buffer.indexOf('\n', lineStart);
      while (lineEnd !== -1) {
        const raw = buffer.slice(lineStart, lineEnd).replace(/\r$/, '').trim();
        if (raw.length > 0) yield safeJsonParse(raw);
        lineStart = lineEnd + 1;
        lineEnd = buffer.indexOf('\n', lineStart);
      }
      buffer = buffer.slice(lineStart);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released — ignore.
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`malformed NDJSON line: ${message} — ${raw.slice(0, 80)}`);
  }
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export interface StoreListQuery {
  search?: string;
  category?: string;
}

export async function listStorePlugins(
  query: StoreListQuery = {},
): Promise<StoreListResponse> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.category) params.set('category', query.category);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return getJson<StoreListResponse>(`/v1/store/plugins${suffix}`);
}

export async function getStorePlugin(id: string): Promise<StoreGetResponse> {
  return getJson<StoreGetResponse>(`/v1/store/plugins/${encodeURIComponent(id)}`);
}

// -----------------------------------------------------------------------------
// Install
// -----------------------------------------------------------------------------

export async function createInstallJob(
  pluginId: string,
): Promise<InstallCreateResponse> {
  return postJson<InstallCreateResponse>(
    `/v1/install/plugins/${encodeURIComponent(pluginId)}`,
    undefined,
  );
}

export async function configureInstallJob(
  jobId: string,
  values: Record<string, unknown>,
): Promise<InstallConfigureResponse> {
  return postJson<InstallConfigureResponse>(
    `/v1/install/jobs/${encodeURIComponent(jobId)}/configure`,
    { values },
  );
}

export async function cancelInstallJob(jobId: string): Promise<void> {
  await postJson<void>(
    `/v1/install/jobs/${encodeURIComponent(jobId)}/cancel`,
    undefined,
  );
}

/**
 * Deinstalliert einen aktiven Agent: ruft den onUninstall-Hook der Runtime
 * (DomainTool wird aus dem Orchestrator entfernt, handle.close() läuft),
 * purgt den Vault-Namespace und entfernt den Registry-Eintrag. 204 = OK.
 */
/**
 * Slice 2.5 — GET full installed-plugin entry including its non-secret
 * config. Used by the Operator-UI's Privacy-Mode quick-picker on the
 * plugin detail page to read the current `_privacy_mode` so the dropdown
 * can initialise with the stored value.
 */
export interface InstalledPluginDetail {
  id: string;
  installed_version: string;
  installed_at: string;
  status: string;
  config: Record<string, unknown>;
  activation_failure_count: number;
  last_activation_error: string | null;
  last_activation_error_at: string | null;
}

export async function getInstalledPlugin(
  pluginId: string,
): Promise<InstalledPluginDetail> {
  return getJson<InstalledPluginDetail>(
    `/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}`,
  );
}

/**
 * Slice 2.5 — PATCH the non-secret config of an installed plugin.
 * Shallow-merges the patch into the existing config: only keys in `patch`
 * are touched, `null` clears a key. Secrets stay in the vault. Used by
 * the Privacy-Mode quick-picker to send `{ _privacy_mode: 'bypass' }`
 * without round-tripping the entire setup_schema.
 */
export async function updateInstalledPluginConfig(
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<{
  updated: { id: string; config: Record<string, unknown>; status: string } | null;
}> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}/config`,
    ),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      credentials: 'include',
      cache: 'no-store',
      body: JSON.stringify(patch),
    },
  );
  if (res.ok) {
    return (await res.json()) as {
      updated: { id: string; config: Record<string, unknown>; status: string } | null;
    };
  }
  const text = await res.text().catch(() => '');
  throw new ApiError(
    res.status,
    `PATCH installed/${pluginId}/config failed: ${res.status}`,
    text,
  );
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/install/installed/${encodeURIComponent(pluginId)}`),
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(res.status, `DELETE installed/${pluginId} failed: ${res.status}`, text);
}

export async function getInstallJob(jobId: string): Promise<InstallJob> {
  const resp = await getJson<{ job: InstallJob }>(
    `/v1/install/jobs/${encodeURIComponent(jobId)}`,
  );
  return resp.job;
}

// -----------------------------------------------------------------------------
// Package uploads (Zip-Upload-Flow)
// -----------------------------------------------------------------------------

/**
 * Lädt ein Zip zum Middleware-Upload-Endpoint. Der Body ist ein
 * `multipart/form-data`-Formular mit genau einem Feld `file`. Content-Type
 * wird NICHT manuell gesetzt — der Browser erzeugt die Boundary.
 */
export async function uploadPackage(
  file: File,
  opts: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<UploadPackageResponse> {
  const forwarded = await forwardCookieHeader();
  const form = new FormData();
  form.append('file', file, file.name);

  // fetch() has no upload-progress in the browser; XHR is the only path that
  // exposes xhr.upload.onprogress. We fall back to fetch() in non-DOM
  // environments (SSR should never hit this anyway).
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') {
    const res = await fetch(botApi('/v1/install/packages/upload'), {
      method: 'POST',
      body: form,
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return handleUploadResponse(res);
  }

  return new Promise<UploadPackageResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', botApi('/v1/install/packages/upload'));
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    for (const [k, v] of Object.entries(forwarded)) {
      xhr.setRequestHeader(k, v);
    }
    if (opts.onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) opts.onProgress?.(ev.loaded, ev.total);
      };
    }
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => xhr.abort());
    }
    xhr.onload = () => {
      const body = xhr.responseText;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(body) as UploadPackageResponse);
        } catch (err) {
          reject(err);
        }
        return;
      }
      reject(new ApiError(xhr.status, `upload failed: ${xhr.status}`, body));
    };
    xhr.onerror = () => {
      reject(new ApiError(0, 'network error during upload', ''));
    };
    xhr.onabort = () => {
      reject(new ApiError(0, 'upload aborted', ''));
    };
    xhr.send(form);
  });
}

async function handleUploadResponse(res: Response): Promise<UploadPackageResponse> {
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `upload failed: ${res.status}`, text);
  }
  return JSON.parse(text) as UploadPackageResponse;
}

// -----------------------------------------------------------------------------
// Profile snapshots (OB-83 + OB-64). The middleware bridge from OB-83 keeps
// `draft_id == profile_id`, so callers in the Builder workspace can pass the
// active draft id directly as `profileId`.
// -----------------------------------------------------------------------------

export async function listSnapshots(
  profileId: string,
): Promise<ListSnapshotsResponse> {
  return getJson<ListSnapshotsResponse>(
    `/v1/profiles/${encodeURIComponent(profileId)}/snapshots`,
  );
}

export async function captureSnapshot(
  profileId: string,
  body: CaptureSnapshotBody = {},
): Promise<CaptureSnapshotResponse> {
  return postJson<CaptureSnapshotResponse>(
    `/v1/profiles/${encodeURIComponent(profileId)}/snapshot`,
    body,
  );
}

export async function markSnapshotDeployReady(
  profileId: string,
  snapshotId: string,
): Promise<SnapshotSummary> {
  return postJson<SnapshotSummary>(
    `/v1/profiles/${encodeURIComponent(profileId)}/snapshots/${encodeURIComponent(snapshotId)}/mark-deploy-ready`,
    {},
  );
}

export async function rollbackSnapshot(
  profileId: string,
  snapshotId: string,
): Promise<RollbackResponse> {
  return postJson<RollbackResponse>(
    `/v1/profiles/${encodeURIComponent(profileId)}/rollback/${encodeURIComponent(snapshotId)}`,
    {},
  );
}

export async function getSnapshotDiff(
  profileId: string,
  base: DiffSideRef,
  target: DiffSideRef,
): Promise<DiffResponse> {
  const params = new URLSearchParams({ base, target });
  return getJson<DiffResponse>(
    `/v1/profiles/${encodeURIComponent(profileId)}/diff?${params.toString()}`,
  );
}

/** Build the absolute `/bot-api/...` URL for the streaming download. */
export function snapshotDownloadUrl(profileId: string, snapshotId: string): string {
  return `/bot-api/v1/profiles/${encodeURIComponent(profileId)}/snapshots/${encodeURIComponent(snapshotId)}/download`;
}

// -----------------------------------------------------------------------------
// Profile-Bundle import (OB-66, Phase 2.4). Mirror of the OB-83 export path:
// the operator picks a Profile-Bundle ZIP, we POST it to the import-bundle
// endpoint, the middleware reconstructs a Builder-Draft (default) or
// overwrites a Bootstrap-Profile (target=profile + overwrite=true).
// -----------------------------------------------------------------------------

export interface ImportProfileBundleOptions {
  /** 'draft' (default for UUID profile-ids in the bundle) creates a fresh
   *  Builder draft. 'profile' writes the bundle into the live state of an
   *  existing Bootstrap-Profile and requires overwrite=true if the live
   *  state already diverges from the bundle. */
  target?: 'draft' | 'profile';
  /** Must be true to replace existing live content on a profile-target
   *  import. Ignored when target='draft'. */
  overwrite?: boolean;
  /** Override for the draft display name. Defaults to the bundle's
   *  manifest profile name. */
  name?: string;
  signal?: AbortSignal;
}

export async function importProfileBundle(
  file: File,
  opts: ImportProfileBundleOptions = {},
): Promise<ImportBundleSuccess> {
  const forwarded = await forwardCookieHeader();
  const form = new FormData();
  form.append('file', file, file.name);
  if (opts.target) form.append('target', opts.target);
  if (opts.overwrite === true) form.append('overwrite', 'true');
  if (opts.name) form.append('name', opts.name);

  const res = await fetch(botApi('/v1/profiles/import-bundle'), {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json', ...forwarded },
    credentials: 'include',
    cache: 'no-store',
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `bundle import failed: ${res.status}`, text);
  }
  return JSON.parse(text) as ImportBundleSuccess;
}

// -----------------------------------------------------------------------------

export async function listUploadedPackages(): Promise<ListUploadedPackagesResponse> {
  return getJson<ListUploadedPackagesResponse>('/v1/install/packages');
}

export async function deleteUploadedPackage(id: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/install/packages/${encodeURIComponent(id)}`),
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(res.status, `DELETE package failed: ${res.status}`, text);
}

// -----------------------------------------------------------------------------
// Plugin registries (admin) + remote install
// -----------------------------------------------------------------------------

/** Non-secret view of a configured registry (the bearer token is write-only
 *  and never returned — only `has_token` flags its presence). */
export interface StoredRegistry {
  name: string;
  url: string;
  has_token: boolean;
}

export interface RegistryListResponse {
  registries: StoredRegistry[];
}

export async function listRegistries(): Promise<RegistryListResponse> {
  return getJson<RegistryListResponse>('/v1/admin/registries');
}

export async function addRegistry(body: {
  name: string;
  url: string;
  token?: string;
}): Promise<void> {
  await postJson<void>('/v1/admin/registries', body);
}

export async function updateRegistry(
  name: string,
  patch: { url?: string; token?: string | null },
): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/admin/registries/${encodeURIComponent(name)}`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(patch),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.ok || res.status === 204) return;
  const text = await res.text().catch(() => '');
  maybeNavigateToLogin(res.status);
  throw new ApiError(res.status, `PATCH registry failed: ${res.status}`, text);
}

export async function deleteRegistry(name: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/admin/registries/${encodeURIComponent(name)}`),
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.ok || res.status === 204) return;
  const text = await res.text().catch(() => '');
  maybeNavigateToLogin(res.status);
  throw new ApiError(res.status, `DELETE registry failed: ${res.status}`, text);
}

export interface RegistryInstallResponse {
  ok: true;
  plugin_id: string;
  version: string;
  registry: string;
  /** C5 — missing `depends_on` parents (already fetched + ingested) the
   *  operator must install before the target. Empty/absent → install the
   *  target directly. Same shape the RequiresWizard consumes. */
  chain?: InstallChainResolution;
  next: { install: string };
}

/**
 * Fetch a plugin ZIP from a configured registry and ingest it locally (C2).
 * Returns the ingested plugin id; the caller then drives the normal install
 * job (`createInstallJob` → `configureInstallJob`) for setup + activation.
 */
export async function installFromRegistry(
  id: string,
  version?: string,
): Promise<RegistryInstallResponse> {
  const suffix = version ? `?version=${encodeURIComponent(version)}` : '';
  return postJson<RegistryInstallResponse>(
    `/v1/install/registry/${encodeURIComponent(id)}${suffix}`,
    undefined,
  );
}

// -----------------------------------------------------------------------------
// System / vault-status
// -----------------------------------------------------------------------------

export interface VaultBackupStatus {
  enabled: boolean;
  bucket: string;
  prefix: string;
  retention: number;
  interval_hours: number;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  objects_kept: number | null;
}

export interface VaultStatusResponse {
  vault: {
    path: string;
    data_dir: string;
    exists: boolean;
    size_bytes: number | null;
    last_modified: string | null;
    agent_count: number;
    master_key_source: 'env' | 'dev-file-existed' | 'dev-file-created';
    production_ready: boolean;
  };
  backup: VaultBackupStatus;
}

export async function getVaultStatus(): Promise<VaultStatusResponse> {
  return getJson<VaultStatusResponse>('/v1/admin/vault-status');
}

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  role: 'admin';
  /** Provider id this session was minted by (OB-49). Older cookies may
   *  carry no value — we fall back to 'entra' on the server-side, so the
   *  type stays a non-empty string. */
  provider: string;
}

export interface AuthMeResponse {
  user: AuthUser;
  /** Session expiry — Unix epoch SECONDS (JWT `exp`). */
  expires_at: number;
  /** Server clock at response time — Unix epoch SECONDS. Lets the client
   *  correct for local clock skew instead of trusting its own `Date.now()`. */
  server_now: number;
}

/**
 * Outcome of a `getSessionStatus` probe. A missing/expired session is a
 * normal result here (`authenticated: false`), not an error — the caller
 * (SessionWatcher) decides how to surface it.
 */
export interface SessionStatus {
  authenticated: boolean;
  user: AuthUser | null;
  /** Session expiry, Unix epoch seconds — null when unauthenticated. */
  expiresAt: number | null;
  /** Server clock at probe time, Unix epoch seconds — null when unauthenticated. */
  serverNow: number | null;
}

export interface AuthProviderSummary {
  id: string;
  displayName: string;
  kind: 'password' | 'oidc';
}

export interface AuthProvidersResponse {
  providers: AuthProviderSummary[];
  /** True iff users-table is empty AND no env-seed values were given.
   *  The login UI flips into "first-time-setup" mode when this is true. */
  setup_required: boolean;
}

export interface AuthLogoutEntry {
  provider: string;
  url: string;
}

export interface AuthLogoutResponse {
  ok: true;
  /** Optional IdP-side logout URLs (one per OIDC provider that had an
   *  active session). Empty array when the active session was local. */
  logout_urls: AuthLogoutEntry[];
}

export interface AuthLoginSuccess {
  ok: true;
  user: AuthUser;
}

export interface AuthSetupSuccess {
  ok: true;
  user: AuthUser;
}

export async function getAuthMe(): Promise<AuthMeResponse> {
  return getJson<AuthMeResponse>('/v1/auth/me');
}

/**
 * Browser-only session probe for the SessionWatcher heartbeat. Unlike
 * `getAuthMe` (via `getJson`), this deliberately does NOT call
 * `maybeNavigateToLogin` on a 401 — the watcher must render its own
 * visible "session expired" overlay first instead of an abrupt redirect.
 * A 401 is therefore an expected outcome, returned as `authenticated:false`.
 */
export async function getSessionStatus(): Promise<SessionStatus> {
  const res = await fetch(botApi('/v1/auth/me'), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    credentials: 'include',
  });
  if (res.status === 401) {
    return {
      authenticated: false,
      user: null,
      expiresAt: null,
      serverNow: null,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `GET /v1/auth/me failed: ${res.status}`,
      text,
    );
  }
  const data = (await res.json()) as AuthMeResponse;
  return {
    authenticated: true,
    user: data.user,
    expiresAt: data.expires_at,
    serverNow: data.server_now,
  };
}

export async function getAuthProviders(): Promise<AuthProvidersResponse> {
  return getJson<AuthProvidersResponse>('/v1/auth/providers');
}

export async function postAuthLogin(
  providerId: string,
  body: { email: string; password: string },
): Promise<AuthLoginSuccess> {
  return postJson<AuthLoginSuccess>(
    `/v1/auth/login/${encodeURIComponent(providerId)}`,
    body,
  );
}

export async function postAuthSetup(body: {
  email: string;
  password: string;
  display_name?: string;
  /** OB-61 — operator-supplied Anthropic key, seeded into the
   *  orchestrator/verifier/extras vault on first-user setup. Optional:
   *  the wizard accepts an empty value (operator can add the key later
   *  via /admin/runtime/secrets) but then the LLM-bound capabilities
   *  stay unpublished until they do. */
  anthropic_api_key?: string;
}): Promise<AuthSetupSuccess> {
  return postJson<AuthSetupSuccess>('/v1/auth/setup', body);
}

export async function postAuthLogout(): Promise<AuthLogoutResponse> {
  return postJson<AuthLogoutResponse>('/v1/auth/logout', undefined);
}

// -----------------------------------------------------------------------------
// Admin — auth-provider toggle (OB-50)
// -----------------------------------------------------------------------------

export interface AdminAuthProvider {
  id: string;
  display_name: string;
  kind: 'password' | 'oidc';
  /** Allowed by AUTH_PROVIDERS env-var (= present in the catalog). */
  configured: boolean;
  /** Currently active in the registry — the login UI will offer it. */
  active: boolean;
}

export interface AdminAuthProvidersResponse {
  providers: AdminAuthProvider[];
}

export async function getAdminAuthProviders(): Promise<AdminAuthProvidersResponse> {
  return getJson<AdminAuthProvidersResponse>('/v1/admin/auth/providers');
}

export async function enableAdminAuthProvider(id: string): Promise<void> {
  await postJson(`/v1/admin/auth/providers/${encodeURIComponent(id)}/enable`, undefined);
}

export async function disableAdminAuthProvider(id: string): Promise<void> {
  await postJson(`/v1/admin/auth/providers/${encodeURIComponent(id)}/disable`, undefined);
}

// -----------------------------------------------------------------------------
// Admin — user management (OB-50)
// -----------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  provider: string;
  display_name: string;
  role: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AdminUsersListResponse {
  users: AdminUser[];
}

export interface AdminUserResponse {
  user: AdminUser;
}

export async function listAdminUsers(): Promise<AdminUsersListResponse> {
  return getJson<AdminUsersListResponse>('/v1/admin/users');
}

export async function getAdminUser(id: string): Promise<AdminUserResponse> {
  return getJson<AdminUserResponse>(`/v1/admin/users/${encodeURIComponent(id)}`);
}

export async function createAdminUser(body: {
  email: string;
  password: string;
  display_name?: string;
}): Promise<AdminUserResponse> {
  return postJson<AdminUserResponse>('/v1/admin/users', body);
}

export async function updateAdminUser(
  id: string,
  body: { display_name?: string; status?: 'active' | 'disabled' },
): Promise<AdminUserResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(`/v1/admin/users/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, `PATCH admin/users/${id} failed: ${res.status}`, text);
  }
  return JSON.parse(text) as AdminUserResponse;
}

export async function resetAdminUserPassword(id: string, password: string): Promise<void> {
  await postJson(
    `/v1/admin/users/${encodeURIComponent(id)}/reset-password`,
    { password },
  );
}

export async function deleteAdminUser(id: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(`/v1/admin/users/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: { accept: 'application/json', ...forwarded },
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(res.status, `DELETE admin/users/${id} failed: ${res.status}`, text);
}

// -----------------------------------------------------------------------------
// Agent-Builder — Phase B.0 (draft CRUD + model catalog)
// -----------------------------------------------------------------------------

export async function listBuilderModels(): Promise<ListBuilderModelsResponse> {
  return getJson<ListBuilderModelsResponse>('/v1/builder/models');
}

export async function listBuilderTemplates(): Promise<ListBuilderTemplatesResponse> {
  return getJson<ListBuilderTemplatesResponse>('/v1/builder/templates');
}

export async function listBuilderDrafts(
  opts: { scope?: DraftListScope } = {},
): Promise<ListDraftsResponse> {
  const params = new URLSearchParams();
  if (opts.scope && opts.scope !== 'active') params.set('scope', opts.scope);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return getJson<ListDraftsResponse>(`/v1/builder/drafts${suffix}`);
}

export async function createBuilderDraft(
  input: { name?: string } = {},
): Promise<DraftEnvelope> {
  return postJson<DraftEnvelope>('/v1/builder/drafts', input);
}

export async function getBuilderDraft(id: string): Promise<DraftEnvelope> {
  return getJson<DraftEnvelope>(`/v1/builder/drafts/${encodeURIComponent(id)}`);
}

export async function updateBuilderDraft(
  id: string,
  patch: {
    name?: string;
    codegen_model?: BuilderModelId;
    preview_model?: BuilderModelId;
  },
): Promise<DraftEnvelope> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(id)}`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(patch),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${id} failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope;
}

export async function deleteBuilderDraft(id: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(id)}`),
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(
    res.status,
    `DELETE builder/drafts/${id} failed: ${res.status}`,
    text,
  );
}

/**
 * Read the slot manifest of the draft's chosen boilerplate template. The
 * Workspace uses this to show "Vom Template gefordert" alongside the
 * user's filled slots so the user can spot missing required slots without
 * waiting for a build to fail.
 */
export async function getTemplateSlots(
  draftId: string,
): Promise<TemplateSlotsResponse> {
  return getJson<TemplateSlotsResponse>(
    `/v1/builder/drafts/${encodeURIComponent(draftId)}/template/slots`,
  );
}

/**
 * Per-draft Monaco lib bundle (B.6-11). Returns the boilerplate's
 * `types.ts` + `@omadia/plugin-api` `.d.ts` exports as virtual
 * lib files keyed by virtual filesystem path. Consumed by the SlotEditor
 * Monaco mount handler via `addExtraLib`.
 */
export async function getDraftLibs(draftId: string): Promise<DraftLibsResponse> {
  return getJson<DraftLibsResponse>(
    `/v1/builder/drafts/${encodeURIComponent(draftId)}/types`,
  );
}

export async function restoreBuilderDraft(id: string): Promise<DraftEnvelope> {
  return postJson<DraftEnvelope>(
    `/v1/builder/drafts/${encodeURIComponent(id)}/restore`,
    undefined,
  );
}

/**
 * Apply a list of JSON-Patches (RFC-6902 add/replace/remove subset) to a
 * draft's AgentSpec. Server-side validation: zod-shaped, with cross-field
 * invariants (reserved tool ids, duplicates, self-dependency) checked
 * before write. Triggers a debounced rebuild and broadcasts a user-cause
 * spec_patch on the SpecEventBus.
 */
export async function patchBuilderSpec(
  id: string,
  patches: JsonPatch[],
): Promise<DraftEnvelope> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(id)}/spec`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ patches }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${id}/spec failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope;
}

/**
 * Phase 3 / OB-67 — set the per-profile persona block on a draft.
 *
 * Issue #53 follow-up — calls the dedicated `PATCH /drafts/:id/persona`
 * route which routes through `setPersonaConfigTool` server-side. That
 * gives us tool-side validation, `SpecEventBus.cause='agent'`, and a
 * `builder_audit` row — parity with BuilderAgent-initiated edits.
 *
 * Replaces any existing `spec.persona` block in full; pass `{}` to clear.
 */
export async function setPersonaConfig(
  draftId: string,
  config: PersonaConfig,
): Promise<DraftEnvelope> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(draftId)}/persona`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(config),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${draftId}/persona failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope;
}

/**
 * Issue #54 — set the per-profile quality block (sycophancy level +
 * boundary presets + custom lines) on a draft.
 *
 * Issue #54 follow-up — calls the dedicated `PATCH /drafts/:id/quality`
 * route which routes through `setQualityConfigTool` server-side. The
 * tool's `warnings` for unknown preset IDs are surfaced as an optional
 * sibling field on the response.
 */
export async function setQualityConfig(
  draftId: string,
  config: import('./builderTypes').QualityConfig,
): Promise<DraftEnvelope & { warnings?: string[] }> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(draftId)}/quality`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(config),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${draftId}/quality failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope & { warnings?: string[] };
}

/**
 * B.11-9: Server-side render of manifest.yaml as it would appear in
 * the next codegen run. Cheap (no zip, no fs writes).
 */
export async function fetchBuilderManifestPreview(
  draftId: string,
): Promise<{ manifest: string }> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/${encodeURIComponent(draftId)}/manifest-preview`,
    ),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...forwarded,
      },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST builder/drafts/${draftId}/manifest-preview failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as { manifest: string };
}

/**
 * B.11-5: Direct tool-call against the preview-runtime.
 * POST /v1/builder/drafts/:id/preview/tool-call
 */
export async function runBuilderPreviewToolCall(
  draftId: string,
  toolId: string,
  input: unknown,
): Promise<{ result: unknown; isError: boolean; durationMs: number }> {
  const forwarded = await forwardCookieHeader();
  const start =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/tool-call`,
    ),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ tool_id: toolId, input }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  const durationMs =
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
    start;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST builder/drafts/${draftId}/preview/tool-call failed: ${res.status}`,
      text,
    );
  }
  const body = JSON.parse(text) as { result: unknown; isError: boolean };
  return { result: body.result, isError: body.isError, durationMs };
}

/** Overwrite a slot's source code. Server triggers a rebuild. */
export async function patchBuilderSlot(
  id: string,
  slotKey: string,
  source: string,
): Promise<DraftEnvelope> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(id)}/slot`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ slotKey, source }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${id}/slot failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope;
}

/**
 * Open a streaming preview turn against `POST /drafts/:id/preview/chat/turn`.
 * The wire format is NDJSON of `PreviewStreamEvent` — chat_message,
 * tool_use, tool_result, build_status (the rebuild that gates the turn),
 * turn_done, and error.
 */
export async function* streamPreviewTurn(
  draftId: string,
  message: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<PreviewStreamEvent> {
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/chat/turn`,
    ),
    {
      method: 'POST',
      headers: {
        accept: 'application/x-ndjson',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
      credentials: 'include',
      cache: 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `POST builder/drafts/${draftId}/preview/chat/turn failed: ${res.status}`,
      text,
    );
  }
  for await (const ev of parseNdjsonLines(res.body, opts.signal)) {
    yield ev as PreviewStreamEvent;
  }
}

/** Force a rebuild of the preview agent. Returns 200 on success or
 *  surfaces the build error rows on failure. */
export async function refreshPreview(draftId: string): Promise<{
  ok: boolean;
  buildN: number;
  agentId: string;
}> {
  return postJson<{
    ok: boolean;
    buildN: number;
    agentId: string;
  }>(`/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/refresh`, undefined);
}

/** Read-only probe of the current preview-cache state. Used on Workspace
 *  mount to re-hydrate buildStatus after a page reload — never triggers
 *  a build. */
export async function getPreviewStatus(draftId: string): Promise<{
  phase: 'idle' | 'ok' | 'failed';
  buildN?: number;
  agentId?: string;
}> {
  return getJson<{
    phase: 'idle' | 'ok' | 'failed';
    buildN?: number;
    agentId?: string;
  }>(`/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/status`);
}

/**
 * Read the buffered preview-secret keys for a draft. Server returns the
 * key set only — the values stay server-side. The Workspace shows
 * "API_KEY ✓ set" badges off this; never renders the bare value.
 *
 * `persistent` reflects whether the server-side buffer is vault-backed
 * (values survive a middleware restart) or heap-only.
 */
export async function getPreviewSecretsStatus(
  draftId: string,
): Promise<{ keys: string[]; persistent?: boolean }> {
  return getJson<{ keys: string[]; persistent?: boolean }>(
    `/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/secrets`,
  );
}

/** Replace the buffered preview secrets. Empty values clears. */
export async function setPreviewSecrets(
  draftId: string,
  values: Record<string, string>,
): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/secrets`,
    ),
    {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ values }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(
    res.status,
    `PUT preview/secrets failed: ${res.status}`,
    text,
  );
}

/** Drop all buffered preview secrets for a draft. */
export async function clearPreviewSecrets(draftId: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/${encodeURIComponent(draftId)}/preview/secrets`,
    ),
    {
      method: 'DELETE',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(
    res.status,
    `DELETE preview/secrets failed: ${res.status}`,
    text,
  );
}

/**
 * Switch the codegen and/or preview model selection. Pure metadata change
 * — server intentionally does NOT trigger a rebuild for model changes
 * (the built artifact is model-agnostic).
 */
export async function patchBuilderModel(
  id: string,
  patch: { codegenModel?: BuilderModelId; previewModel?: BuilderModelId },
): Promise<DraftEnvelope> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(id)}/model`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(patch),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PATCH builder/drafts/${id}/model failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as DraftEnvelope;
}

/**
 * Install-commit a draft (B.6-1). Returns the parsed body for both success
 * (HTTP 200, `{ ok: true, ... }`) and failure (HTTP 4xx/5xx, `{ ok: false,
 * reason, code, message, details? }`) so the InstallDiffModal can render
 * conflict / build-error details inline. Throws ApiError ONLY on transport
 * failure or when the body cannot be parsed as JSON — every documented
 * orchestrator outcome (404 / 409 / 413 / 422 / 500) returns a typed
 * InstallResponse.
 */
export async function installBuilderDraft(
  draftId: string,
): Promise<InstallResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(draftId)}/install`),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      res.status,
      `POST builder/drafts/${draftId}/install: non-JSON body (HTTP ${String(res.status)})`,
      text,
    );
  }
  // 401 / 403 are surfaced as ApiError because they indicate a session issue
  // rather than an install-flow outcome. Everything 2xx + 4xx/5xx with the
  // documented `{ ok }` envelope is returned as InstallResponse.
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      res.status,
      `POST builder/drafts/${draftId}/install: ${String(res.status)}`,
      text,
    );
  }
  return parsed as InstallResponse;
}

/**
 * Edit-from-Store (B.6-3). Clones the source draft of a published plugin
 * into a fresh draft and returns the new draft id so the UI can redirect
 * to `/store/builder/<draftId>`. The previously-published plugin stays
 * live; the new draft starts in `status='draft'` with no
 * `published_agent_id` link until the operator runs install again.
 *
 * Same response semantics as `installBuilderDraft`: returns the parsed
 * body for documented HTTP outcomes (201 / 404 / 409); throws ApiError
 * only on transport failure or 401/403.
 */
export async function cloneBuilderDraftFromInstalled(
  publishedAgentId: string,
): Promise<CloneFromInstalledResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/builder/drafts/from-installed/${encodeURIComponent(publishedAgentId)}`,
    ),
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(
      res.status,
      `POST builder/drafts/from-installed/${publishedAgentId}: non-JSON body (HTTP ${String(res.status)})`,
      text,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(
      res.status,
      `POST builder/drafts/from-installed/${publishedAgentId}: ${String(res.status)}`,
      text,
    );
  }
  return parsed as CloneFromInstalledResponse;
}

const RESUME_RETRY_DELAYS_MS = [0, 500, 2_000, 5_000] as const;

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/**
 * Open a streaming builder turn against `POST /drafts/:id/turn`. Yields each
 * `BuilderTurnEvent` as the server emits it. Throws on hard transport
 * errors and on `signal.abort()`; the consumer must drain the iterator to
 * keep the underlying connection from leaking.
 *
 * Reconnect (B.5-3): the first frame of every successful turn is
 * `turn_started` with the server's `turnId`, and every subsequent frame
 * carries a monotonic `id`. When the live stream drops mid-turn we
 * transparently re-attach via `GET /drafts/:id/turn/:turnId/resume?since=<lastId>`,
 * deduping on `id` so a frame the client already received is not yielded
 * twice. The retry schedule is bounded; once we exhaust it we give up
 * with a clear error.
 */
export async function* streamBuilderTurn(
  draftId: string,
  message: string,
  opts: { model?: BuilderModelId; signal?: AbortSignal } = {},
): AsyncGenerator<BuilderTurnEvent> {
  const body: { message: string; model?: BuilderModelId } = { message };
  if (opts.model) body.model = opts.model;

  let turnId: string | null = null;
  let lastId = 0;
  let done = false;

  function isLikelyTransientNetworkError(err: unknown): boolean {
    // Browsers throw a TypeError ("network error", "load failed") on
    // mid-stream disconnect. Server-side fetch is similar but with
    // err.cause set. Anything else (parse error, HTTP error inside
    // ApiError) is non-retryable.
    if (err instanceof TypeError) return true;
    if (err instanceof Error && /network|fetch failed|stream/i.test(err.message)) {
      return true;
    }
    return false;
  }

  // First leg: open the live POST stream.
  try {
    const res = await fetch(
      botApi(`/v1/builder/drafts/${encodeURIComponent(draftId)}/turn`),
      {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'include',
        cache: 'no-store',
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ApiError(
        res.status,
        `POST builder/drafts/${draftId}/turn failed: ${res.status}`,
        text,
      );
    }
    for await (const raw of parseNdjsonLines(res.body, opts.signal)) {
      const ev = raw as BuilderTurnEvent;
      if (typeof ev.id === 'number') lastId = ev.id;
      if (ev.type === 'turn_started') turnId = ev.turnId;
      if (ev.type === 'turn_done' || ev.type === 'error') done = true;
      yield ev;
      if (done) return;
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!turnId || !isLikelyTransientNetworkError(err)) throw err;
    // fall through into the resume loop
  }

  if (done || turnId === null) return;

  // Resume loop — bounded retries, backoff between attempts.
  for (const delayMs of RESUME_RETRY_DELAYS_MS) {
    if (opts.signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }
    try {
      const url = botApi(
        `/v1/builder/drafts/${encodeURIComponent(draftId)}/turn/${encodeURIComponent(turnId)}/resume?since=${String(lastId)}`,
      );
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/x-ndjson' },
        credentials: 'include',
        cache: 'no-store',
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.status === 404 || res.status === 503) {
        // Buffer GC'd or never-existed → no replay possible. Surface a
        // synthetic error event so the consumer can show the right banner
        // without distinguishing transport vs. server state.
        yield {
          type: 'error',
          code: 'builder.resume_unavailable',
          message: `resume of turn ${turnId} unavailable (status ${String(res.status)})`,
        } as BuilderTurnEvent;
        return;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new ApiError(
          res.status,
          `GET resume turn ${turnId} failed: ${res.status}`,
          text,
        );
      }
      for await (const raw of parseNdjsonLines(res.body, opts.signal)) {
        const ev = raw as BuilderTurnEvent;
        if (typeof ev.id === 'number' && ev.id <= lastId) continue;
        if (typeof ev.id === 'number') lastId = ev.id;
        if (ev.type === 'turn_done' || ev.type === 'error') done = true;
        yield ev;
        if (done) return;
      }
      // Resume stream closed cleanly without a terminator — turn is still
      // running on the server; loop into the next backoff and re-attach.
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!isLikelyTransientNetworkError(err)) throw err;
      // else: backoff loop continues
    }
  }

  // Exhausted retries.
  yield {
    type: 'error',
    code: 'builder.resume_exhausted',
    message: `gave up resuming turn ${turnId} after ${String(RESUME_RETRY_DELAYS_MS.length)} attempts`,
  } as BuilderTurnEvent;
}

// -----------------------------------------------------------------------------
// Bootstrap-Profiles (S+12)
// -----------------------------------------------------------------------------

export async function listProfiles(): Promise<ProfileListResponse> {
  return getJson<ProfileListResponse>('/v1/profiles/');
}

export async function getProfile(id: string): Promise<ProfileDetail> {
  return getJson<ProfileDetail>(`/v1/profiles/${encodeURIComponent(id)}`);
}

export async function applyProfile(
  profileId: string,
): Promise<ProfileApplyOutcome> {
  return postJson<ProfileApplyOutcome>(
    `/v1/profiles/${encodeURIComponent(profileId)}/apply`,
    undefined,
  );
}

/**
 * Browser-only — returns the URL for `<a href>` triggering a YAML download.
 * Do not use this from Server Components; the route is auth-gated and the
 * cookie sits in the browser, not in RSC fetches.
 */
export function profileExportUrl(): string {
  return '/bot-api/v1/profiles/export';
}

// -----------------------------------------------------------------------------
// Theme D: post-install credential editing
// -----------------------------------------------------------------------------

/**
 * List stored setup-field state for an installed plugin.
 *
 * `keys`          — secret-typed key NAMES (vault). Values are never
 *                   returned — secrets stay server-side.
 * `config_keys`   — non-secret setup-field NAMES stored in
 *                   registry.config (string/url/enum/boolean/integer).
 *                   Redundant with `Object.keys(config_values)` but kept
 *                   for backwards compat with older clients.
 * `config_values` — actual stored values for the non-secret fields, as
 *                   strings. The editor uses this to populate the
 *                   current selection in dropdowns / text inputs.
 */
export async function listInstalledSecretKeys(
  pluginId: string,
): Promise<InstalledSecretsState> {
  return getJson<InstalledSecretsState>(
    `/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}/secrets`,
  );
}

export interface InstalledSecretsState {
  keys: string[];
  config_keys: string[];
  config_values: Record<string, string>;
}

/**
 * Patch the credentials for an installed plugin.
 *   set    — upsert these (key, value) pairs.
 *   delete — remove these keys.
 * The middleware rejects an empty patch with 400, so callers should
 * gate the call to "at least one entry exists". The middleware splits
 * each entry into vault (secret/oauth fields) vs registry config
 * (everything else) using the plugin's manifest setup-schema.
 */
export async function patchInstalledSecrets(
  pluginId: string,
  patch: { set?: Record<string, string>; delete?: string[] },
): Promise<InstalledSecretsState> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}/secrets`,
    ),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(patch),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `PATCH installed/${pluginId}/secrets failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as InstalledSecretsState;
}

/**
 * #91 — set the audit egress mode for an installed web_scanner plugin.
 * The middleware validates the mode enum and rejects the call when the
 * plugin does not declare `permissions.network.web_scanner`.
 */
export async function setAuditMode(
  pluginId: string,
  mode: AuditMode,
): Promise<{ id: string; audit_mode: AuditMode }> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(
      `/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}/audit-mode`,
    ),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ mode }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `PATCH installed/${pluginId}/audit-mode failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as { id: string; audit_mode: AuditMode };
}

// -----------------------------------------------------------------------------
// Routines (operator dashboard)
// -----------------------------------------------------------------------------

/**
 * Phase C — server-side output template (mirrors `RoutineOutputTemplate`
 * in the middleware). Operator UI surfaces and edits this blob; rendering
 * happens server-side at routine-trigger time.
 *
 * Kept as the structural shape rather than `unknown` so the editor /
 * preview UI can offer mild type help (autocompletion, validation
 * hints) — the canonical validation is the backend's
 * `parseRoutineOutputTemplate`.
 */
export interface RoutineOutputTemplateDto {
  format: 'markdown' | 'adaptive-card' | 'html';
  sections: ReadonlyArray<RoutineTemplateSectionDto>;
}

export type RoutineTemplateSectionDto =
  | { kind: 'narrative-slot'; id: string; hint?: string }
  | {
      kind: 'data-table';
      sourceTool: string;
      sourcePath?: string;
      title?: string;
      titleSlot?: string;
      groupBy?: string;
      columns: ReadonlyArray<{
        label: string;
        field: string;
        format?: 'date' | 'currency' | 'plain';
      }>;
      emptyText?: string;
    }
  | {
      kind: 'data-list';
      sourceTool: string;
      sourcePath?: string;
      title?: string;
      titleSlot?: string;
      itemTemplate: string;
      emptyText?: string;
    }
  | { kind: 'static-markdown'; text: string };

export interface RoutineDto {
  id: string;
  tenant: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  status: 'active' | 'paused';
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'error' | 'timeout' | null;
  lastRunError: string | null;
  outputTemplate: RoutineOutputTemplateDto | null;
}

export interface ListRoutinesResponse {
  routines: RoutineDto[];
  count: number;
}

export interface RoutineResponse {
  routine: RoutineDto;
}

export async function listRoutines(): Promise<ListRoutinesResponse> {
  return getJson<ListRoutinesResponse>('/v1/routines');
}

export async function setRoutineStatus(
  id: string,
  status: 'active' | 'paused',
): Promise<RoutineResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/routines/${encodeURIComponent(id)}/status`),
    {
      method: 'PATCH',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ status }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `PATCH routines/${id}/status failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as RoutineResponse;
}

export async function triggerRoutineNow(
  id: string,
): Promise<RoutineResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/routines/${encodeURIComponent(id)}/trigger`),
    {
      method: 'POST',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `POST routines/${id}/trigger failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as RoutineResponse;
}

/**
 * Phase C.7 — Set or clear a routine's `output_template`. Passing `null`
 * reverts the routine to the legacy LLM-renders path. The backend
 * validates the shape via `parseRoutineOutputTemplate` and returns 400
 * with a `routines.template_invalid` reason on malformed input.
 */
export async function setRoutineTemplate(
  id: string,
  template: RoutineOutputTemplateDto | null,
): Promise<RoutineResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/routines/${encodeURIComponent(id)}/template`),
    {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({ template }),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `PUT routines/${id}/template failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as RoutineResponse;
}

export type PreviewRoutineTemplateResponse =
  | { ok: true; format: 'markdown'; text: string }
  | { ok: true; format: 'adaptive-card'; items: readonly unknown[] }
  | { ok: false; reason: string };

/**
 * Phase C.7 — Preview-render a template against operator-supplied
 * synthetic raw tool results + slot values. Stateless: the backend
 * never reads or writes the routine row, so this works for templates
 * the operator hasn't saved yet. Returns the renderer's discriminated
 * union verbatim so the UI can render either markdown text or the
 * Adaptive Card item JSON.
 */
export async function previewRoutineTemplate(input: {
  template: RoutineOutputTemplateDto;
  rawToolResults?: Record<string, unknown>;
  slots?: Record<string, string>;
  locale?: string;
  currency?: string;
}): Promise<PreviewRoutineTemplateResponse> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi('/v1/routines/preview-template'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
    },
    body: JSON.stringify(input),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(
      res.status,
      `POST routines/preview-template failed: ${res.status}`,
      text,
    );
  }
  return (await res.json()) as PreviewRoutineTemplateResponse;
}

export async function deleteRoutine(id: string): Promise<void> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi(`/v1/routines/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: { accept: 'application/json', ...forwarded },
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status === 204) return;
  const text = await res.text().catch(() => '');
  throw new ApiError(
    res.status,
    `DELETE routines/${id} failed: ${res.status}`,
    text,
  );
}

export type RoutineRunTrigger = 'cron' | 'catchup' | 'manual';
export type RoutineRunStatus = 'ok' | 'error' | 'timeout';

/**
 * Lightweight summary used for the per-routine run-history list. The full
 * agentic trace is fetched lazily via `getRoutineRun(id, runId)` when the
 * operator opens the call-stack viewer.
 */
export interface RoutineRunSummaryDto {
  id: string;
  routineId: string;
  trigger: RoutineRunTrigger;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: RoutineRunStatus;
  errorMessage: string | null;
  iterations: number | null;
  toolCalls: number | null;
}

export interface RoutineRunDetailDto extends RoutineRunSummaryDto {
  prompt: string;
  answer: string | null;
  /** Full agentic trace as stored in JSONB. Rendered by a generic JSON-tree
   *  viewer on the run-detail page. */
  runTrace: unknown | null;
}

export interface ListRoutineRunsResponse {
  runs: RoutineRunSummaryDto[];
  count: number;
}

export interface RoutineRunResponse {
  run: RoutineRunDetailDto;
}

export async function listRoutineRuns(
  id: string,
  opts: { limit?: number } = {},
): Promise<ListRoutineRunsResponse> {
  const params = new URLSearchParams();
  if (typeof opts.limit === 'number' && Number.isFinite(opts.limit)) {
    params.set('limit', String(Math.trunc(opts.limit)));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return getJson<ListRoutineRunsResponse>(
    `/v1/routines/${encodeURIComponent(id)}/runs${suffix}`,
  );
}

export async function getRoutineRun(
  id: string,
  runId: string,
): Promise<RoutineRunResponse> {
  return getJson<RoutineRunResponse>(
    `/v1/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
  );
}

// ─── Native issue-reporting (concept plan) ─────────────────────────────────

export type WorkaroundConfirmIssueResponse = {
  ok: true;
  workaround: {
    id: string;
    fingerprint: string;
    summary: string;
    createdAt: number;
    issueRef: {
      owner: string;
      repo: string;
      number: number;
      url: string;
    };
  };
  issueState: 'open' | 'closed';
  closedAt: number | null;
};

export async function confirmBuilderIssue(input: {
  draftId: string;
  issueNumber: number;
  fingerprint: string;
  summary: string;
}): Promise<WorkaroundConfirmIssueResponse> {
  return postJson<WorkaroundConfirmIssueResponse>(
    `/v1/builder/drafts/${encodeURIComponent(input.draftId)}/workarounds/confirm-issue`,
    {
      issueNumber: input.issueNumber,
      fingerprint: input.fingerprint,
      summary: input.summary,
    },
  );
}

export type CreateBuilderIssueResponse = {
  ok: true;
  mode: 'created' | 'reused';
  workaround: WorkaroundConfirmIssueResponse['workaround'];
  issueRef?: {
    owner: string;
    repo: string;
    number: number;
    url: string;
  };
};

/**
 * Issue #206 (v1.2): server-side direct issue creation via the GitHub App.
 * Used by the IssueReportCard for the `created-pending` mode. The server
 * re-sanitizes the body, dedups, files the issue, and persists the
 * workaround. Throws `ApiError` on failure — a 409 means no GitHub App is
 * wired, so the caller should fall back to the browser-submit flow.
 */
export async function createBuilderIssue(input: {
  draftId: string;
  title: string;
  body: string;
  fingerprint: string;
  summary: string;
}): Promise<CreateBuilderIssueResponse> {
  return postJson<CreateBuilderIssueResponse>(
    `/v1/builder/drafts/${encodeURIComponent(input.draftId)}/workarounds/create-issue`,
    {
      title: input.title,
      body: input.body,
      fingerprint: input.fingerprint,
      summary: input.summary,
    },
  );
}

export async function resolveBuilderUserChoice(input: {
  draftId: string;
  choiceId: string;
  value: string;
}): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>(
    `/v1/builder/drafts/${encodeURIComponent(input.draftId)}/user-choice/${encodeURIComponent(input.choiceId)}`,
    { value: input.value },
  );
}

export async function cancelBuilderUserChoice(input: {
  draftId: string;
  choiceId: string;
}): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>(
    `/v1/builder/drafts/${encodeURIComponent(input.draftId)}/user-choice/${encodeURIComponent(input.choiceId)}`,
    { cancel: true },
  );
}

export async function resumeBuilderFromIssue(input: {
  draftId: string;
  force?: boolean;
}): Promise<{
  ok: true;
  resumedAt: number;
  issueState: string;
  forced: boolean;
}> {
  return postJson(
    `/v1/builder/drafts/${encodeURIComponent(input.draftId)}/resume-from-issue`,
    { force: input.force === true },
  );
}

// ── Builder quality score (issue #52) ───────────────────────────────────────

export interface QualitySuggestion {
  code: string;
  message: string;
  dimension: 'completeness' | 'tokenEfficiency' | 'ruleQuality' | 'specificity';
}

export interface BuilderQualityResult {
  draftId: string;
  score: number;
  dimensions: {
    completeness: number;
    tokenEfficiency: number;
    ruleQuality: number;
    specificity: number;
  };
  sweetspot: 'under' | 'sweet' | 'over';
  tokenHealth: 'ok' | 'warning' | 'critical';
  suggestions: QualitySuggestion[];
}

export async function fetchBuilderQuality(
  draftId: string,
): Promise<BuilderQualityResult> {
  return getJson<BuilderQualityResult>(
    `/v1/builder/drafts/${encodeURIComponent(draftId)}/quality`,
  );
}

// ── Builder preview prompt (issue #55) ──────────────────────────────────────

export interface PreviewPromptSection {
  label: string;
  content: string;
  kind: 'header' | 'persona' | 'boundaries' | 'sycophancy' | 'skill' | 'custom_notes';
}

export interface BuilderPreviewPrompt {
  systemPrompt: string;
  tokens: number;
  sections: PreviewPromptSection[];
}

/**
 * Issue #55 — render the live compiled system prompt for a draft.
 * POST so the route can carry future options (token-count mode, etc.)
 * without breaking the GET surface.
 */
export async function fetchBuilderPreviewPrompt(
  draftId: string,
): Promise<BuilderPreviewPrompt> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(
    botApi(`/v1/builder/drafts/${encodeURIComponent(draftId)}/preview-prompt`),
    {
      method: 'POST',
      headers: { accept: 'application/json', ...forwarded },
      credentials: 'include',
      cache: 'no-store',
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST /v1/builder/drafts/${draftId}/preview-prompt failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as BuilderPreviewPrompt;
}

// ── Builder audit log (issue #57) ───────────────────────────────────────────

export interface BuilderAuditEvent {
  id: number;
  draftId: string;
  userEmail: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface BuilderAuditPage {
  draftId: string;
  total: number;
  limit: number;
  offset: number;
  events: BuilderAuditEvent[];
}

/**
 * Paginated audit-log fetch for a draft. Backed by the `GET /v1/builder/
 * drafts/:id/audit` route added in #56. Newest-first; default page size
 * is 30 (server clamps 1..200).
 */
export async function listBuilderAudit(
  draftId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<BuilderAuditPage> {
  const q = new URLSearchParams();
  if (typeof opts.limit === 'number') q.set('limit', String(opts.limit));
  if (typeof opts.offset === 'number') q.set('offset', String(opts.offset));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return getJson<BuilderAuditPage>(
    `/v1/builder/drafts/${encodeURIComponent(draftId)}/audit${suffix}`,
  );
}

// -----------------------------------------------------------------------------
// MemorableKnowledge (Slice 3b REST surface)
//
// Backend lives at /api/v1/memory and is gated by `requireAuth` — every
// route uses `requireSessionUserId`, so the browser MUST be logged in.
// `listMemories` returns only MKs the session user is both INVOLVED in
// AND an acl_owner of (Slice 3 strict-ACL semantic).
// -----------------------------------------------------------------------------

export type MemorableKind = 'decision' | 'insight' | 'preference' | 'reference';

export interface MemorableKnowledgeNode {
  id: string;
  type: 'MemorableKnowledge';
  props: {
    kind: MemorableKind;
    summary: string;
    rationale?: string;
    significance?: number;
    acl_owners: string[];
    created_at: string;
    created_by: string;
    [key: string]: unknown;
  };
}

export interface ListMemoriesResponse {
  items: MemorableKnowledgeNode[];
}

export interface ListMemoriesOptions {
  kind?: MemorableKind;
  limit?: number;
}

export async function listMemories(
  opts: ListMemoriesOptions = {},
): Promise<ListMemoriesResponse> {
  const params = new URLSearchParams();
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return getJson<ListMemoriesResponse>(`/v1/memory${qs ? `?${qs}` : ''}`);
}

export async function getMemory(id: string): Promise<MemorableKnowledgeNode> {
  return getJson<MemorableKnowledgeNode>(
    `/v1/memory/${encodeURIComponent(id)}`,
  );
}

export type ExcerptSource = 'llm' | 'hint' | 'fallback';

export interface PalaiaExcerptsInput {
  texts: readonly string[];
  source: ExcerptSource;
}

export interface PalaiaExcerptNode {
  id: string;
  type: 'PalaiaExcerpt';
  props: {
    text: string;
    position: number;
    source: ExcerptSource;
    created_at: string;
  };
}

export interface CreateMemoryRequest {
  kind: MemorableKind;
  summary: string;
  rationale?: string;
  significance?: number;
  involvedOmadiaUserIds?: string[];
  requiredEntityIds?: string[];
  derivedFromTurnIds?: string[];
  aclOwners?: string[];
  /** Slice 6.5 — verbatim source-snippets to persist alongside the MK
   *  in the same transaction. Empty `texts` is a no-op (the backend
   *  short-circuits and writes no PalaiaExcerpt nodes). */
  palaiaExcerpts?: PalaiaExcerptsInput;
}

export interface CreateMemoryResponse {
  memorableKnowledgeNodeId: string;
  skippedInvolved: number;
  skippedRequired: number;
  skippedDerivedFrom: number;
}

export async function createMemory(
  body: CreateMemoryRequest,
): Promise<CreateMemoryResponse> {
  return postJson<CreateMemoryResponse>('/v1/memory', body);
}

export interface UpdateMemoryRequest {
  kind?: MemorableKind;
  summary?: string;
  /** `null` removes the rationale; omit to leave untouched; string sets it. */
  rationale?: string | null;
  significance?: number;
  /** Optional rationale for the ACL audit-log row this PATCH writes. */
  reason?: string;
}

export async function updateMemory(
  id: string,
  patch: UpdateMemoryRequest,
): Promise<MemorableKnowledgeNode> {
  const res = await fetch(`/bot-api/v1/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw new Error(body.code ?? body.message ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as MemorableKnowledgeNode;
}

export async function deleteMemory(
  id: string,
  reason?: string,
): Promise<void> {
  const res = await fetch(`/bot-api/v1/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 204) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    throw new Error(body.code ?? `HTTP ${String(res.status)}`);
  }
}

export type MemorableAclAction =
  | 'create'
  | 'expand'
  | 'shrink'
  | 'delete'
  | 'edit'
  | 'edit_excerpt';

export interface MemorableAclAuditEntry {
  id: string;
  memoryExternalId: string;
  actorOmadiaUserId: string;
  actorChannelIdentityId?: string;
  action: MemorableAclAction;
  beforeOwners: string[];
  /** `null` only when `action === 'delete'`. */
  afterOwners: string[] | null;
  reason?: string;
  createdAt: string;
}

export interface ListMemoryAuditResponse {
  items: MemorableAclAuditEntry[];
}

export async function getMemoryAudit(
  id: string,
  opts: { limit?: number } = {},
): Promise<ListMemoryAuditResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return getJson<ListMemoryAuditResponse>(
    `/v1/memory/${encodeURIComponent(id)}/audit${qs ? `?${qs}` : ''}`,
  );
}

// ── Slice 6.5 — Palaia-Excerpt provenance ────────────────────────────────────

export interface ListMemoryExcerptsResponse {
  items: PalaiaExcerptNode[];
}

export async function getMemoryExcerpts(
  id: string,
): Promise<ListMemoryExcerptsResponse> {
  return getJson<ListMemoryExcerptsResponse>(
    `/v1/memory/${encodeURIComponent(id)}/excerpts`,
  );
}

export interface UpdateExcerptRequest {
  text?: string;
  source?: ExcerptSource;
  reason?: string;
}

export async function updateMemoryExcerpt(
  id: string,
  position: number,
  patch: UpdateExcerptRequest,
): Promise<PalaiaExcerptNode> {
  const res = await fetch(
    `/bot-api/v1/memory/${encodeURIComponent(id)}/excerpts/${String(position)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      credentials: 'include',
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw new Error(body.code ?? body.message ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as PalaiaExcerptNode;
}

// ── Slice 8 — Retrospective bulk score + promotion ───────────────────────────

export interface BulkPromotePreview {
  nullSignificanceCount: number;
  eligibleForPromoteCount: number;
  alreadyPromotedCount: number;
  scorerAvailable: boolean;
  threshold: number;
}

export interface BulkPromoteRunOptions {
  scoreLimit?: number;
  promoteLimit?: number;
  threshold?: number;
}

export interface BulkPromoteRunResult {
  scorePhase: { scanned: number; scored: number; failed: number };
  promotePhase: {
    scanned: number;
    promoted: number;
    alreadyPromoted: number;
    belowThreshold: number;
    failed: number;
  };
  durationMs: number;
}

export async function previewBulkPromote(
  threshold = 0.7,
): Promise<BulkPromotePreview> {
  return getJson<BulkPromotePreview>(
    `/v1/admin/bulk-promote/preview?threshold=${String(threshold)}`,
  );
}

export async function runBulkPromote(
  options: BulkPromoteRunOptions,
): Promise<BulkPromoteRunResult> {
  return postJson<BulkPromoteRunResult>(
    '/v1/admin/bulk-promote',
    options,
  );
}

// ── Slice 9 — Contradiction detection workflow ───────────────────────────────

export type InconsistencyStatus = 'open' | 'resolved' | 'dismissed';
export type InconsistencyResolution =
  | 'a_wins' | 'b_wins' | 'both' | 'dismiss';
export type InconsistencySeverity = 'low' | 'medium' | 'high';

export interface InconsistencyNodeDto {
  id: string;
  type: 'Inconsistency';
  props: {
    summary: string;
    severity: InconsistencySeverity;
    status: InconsistencyStatus;
    resolution: InconsistencyResolution | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
  };
  conflictsWith: [string, string];
}

export interface InconsistencyDetailDto extends InconsistencyNodeDto {
  mkA: MemorableKnowledgeNode | null;
  mkB: MemorableKnowledgeNode | null;
}

export interface ListInconsistenciesResponse {
  items: InconsistencyDetailDto[];
}

export async function listInconsistencies(opts: {
  status?: InconsistencyStatus;
  limit?: number;
} = {}): Promise<ListInconsistenciesResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return getJson<ListInconsistenciesResponse>(
    `/v1/admin/inconsistencies${qs ? `?${qs}` : ''}`,
  );
}

export async function getInconsistencyDetail(
  id: string,
): Promise<InconsistencyDetailDto> {
  return getJson<InconsistencyDetailDto>(
    `/v1/admin/inconsistencies/${encodeURIComponent(id)}`,
  );
}

export async function resolveInconsistency(
  id: string,
  body: { resolution: InconsistencyResolution; reason?: string },
): Promise<InconsistencyNodeDto> {
  return postJson<InconsistencyNodeDto>(
    `/v1/admin/inconsistencies/${encodeURIComponent(id)}/resolve`,
    body,
  );
}

export async function triggerInconsistencyDetect(
  mkId: string,
): Promise<{ candidatesScanned: number; inconsistenciesCreated: number }> {
  return postJson<{ candidatesScanned: number; inconsistenciesCreated: number }>(
    '/v1/admin/inconsistencies/detect',
    { mkId },
  );
}

// ─── Slice 9.5 — bulk inconsistency detect ───────────────────────────

export interface BulkInconsistencyPreviewDto {
  unchecked: number;
  alreadyChecked: number;
  withoutEmbedding: number;
  detectorAvailable: boolean;
}

export interface BulkInconsistencyResultDto {
  scanned: number;
  checked: number;
  inconsistenciesCreated: number;
  skippedNoEmbedding: number;
  failed: number;
  durationMs: number;
}

export async function previewBulkInconsistencyDetect(): Promise<BulkInconsistencyPreviewDto> {
  return getJson<BulkInconsistencyPreviewDto>(
    '/v1/admin/inconsistencies/bulk-detect/preview',
  );
}

export async function runBulkInconsistencyDetect(
  limit?: number,
): Promise<BulkInconsistencyResultDto> {
  return postJson<BulkInconsistencyResultDto>(
    '/v1/admin/inconsistencies/bulk-detect',
    limit !== undefined ? { limit } : {},
  );
}

// ─── Slice 10 — near-duplicate (MergeCandidate) workflow ─────────────

export type MergeCandidateStatus = 'open' | 'resolved' | 'dismissed';
export type MergeCandidateResolution = 'keep_a' | 'keep_b' | 'not_duplicate';

export interface MergeCandidateNodeDto {
  id: string;
  type: 'MergeCandidate';
  props: {
    cosine_sim: number;
    status: MergeCandidateStatus;
    resolution: MergeCandidateResolution | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
  };
  duplicateOf: [string, string];
}

export interface MergeCandidateDetailDto extends MergeCandidateNodeDto {
  mkA: MemorableKnowledgeNode | null;
  mkB: MemorableKnowledgeNode | null;
}

export interface ListMergeCandidatesResponse {
  items: MergeCandidateDetailDto[];
}

export async function listMergeCandidates(opts: {
  status?: MergeCandidateStatus;
  limit?: number;
} = {}): Promise<ListMergeCandidatesResponse> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return getJson<ListMergeCandidatesResponse>(
    `/v1/admin/duplicates${qs ? `?${qs}` : ''}`,
  );
}

export async function getMergeCandidateDetail(
  id: string,
): Promise<MergeCandidateDetailDto> {
  return getJson<MergeCandidateDetailDto>(
    `/v1/admin/duplicates/${encodeURIComponent(id)}`,
  );
}

export async function resolveMergeCandidate(
  id: string,
  body: { resolution: MergeCandidateResolution; reason?: string },
): Promise<MergeCandidateNodeDto> {
  return postJson<MergeCandidateNodeDto>(
    `/v1/admin/duplicates/${encodeURIComponent(id)}/resolve`,
    body,
  );
}

export async function triggerMergeCandidateDetect(
  mkId: string,
): Promise<{ candidatesScanned: number; mergeCandidatesCreated: number }> {
  return postJson<{
    candidatesScanned: number;
    mergeCandidatesCreated: number;
  }>('/v1/admin/duplicates/detect', { mkId });
}

export interface BulkMergeDetectPreviewDto {
  unchecked: number;
  alreadyChecked: number;
  withoutEmbedding: number;
  detectorAvailable: boolean;
}

export interface BulkMergeDetectResultDto {
  scanned: number;
  checked: number;
  mergeCandidatesCreated: number;
  skippedNoEmbedding: number;
  failed: number;
  durationMs: number;
}

export async function previewBulkMergeDetect(): Promise<BulkMergeDetectPreviewDto> {
  return getJson<BulkMergeDetectPreviewDto>(
    '/v1/admin/duplicates/bulk-detect/preview',
  );
}

export async function runBulkMergeDetect(
  limit?: number,
): Promise<BulkMergeDetectResultDto> {
  return postJson<BulkMergeDetectResultDto>(
    '/v1/admin/duplicates/bulk-detect',
    limit !== undefined ? { limit } : {},
  );
}

// ─── Slice 12 — ExcerptMergeCandidate workflow ───────────────────────

export type ExcerptMergeStatus = 'open' | 'resolved' | 'dismissed';
export type ExcerptMergeResolution = 'keep_a' | 'keep_b' | 'not_duplicate';

export interface ExcerptMergeNodeDto {
  id: string;
  type: 'ExcerptMergeCandidate';
  props: {
    cosine_sim: number;
    status: ExcerptMergeStatus;
    resolution: ExcerptMergeResolution | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
  };
  duplicateExcerptOf: [string, string];
}

export interface ExcerptMergeDetailDto extends ExcerptMergeNodeDto {
  excerptA: {
    id: string;
    type: 'PalaiaExcerpt';
    props: {
      text: string;
      position: number;
      source: string;
      created_at: string;
    };
  } | null;
  excerptB: ExcerptMergeDetailDto['excerptA'];
  mkA: MemorableKnowledgeNode | null;
  mkB: MemorableKnowledgeNode | null;
}

export async function listExcerptMergeCandidates(opts: {
  status?: ExcerptMergeStatus;
  limit?: number;
} = {}): Promise<{ items: ExcerptMergeDetailDto[] }> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return getJson<{ items: ExcerptMergeDetailDto[] }>(
    `/v1/admin/duplicates/excerpts${qs ? `?${qs}` : ''}`,
  );
}

export async function getExcerptMergeDetail(
  id: string,
): Promise<ExcerptMergeDetailDto> {
  return getJson<ExcerptMergeDetailDto>(
    `/v1/admin/duplicates/excerpts/${encodeURIComponent(id)}`,
  );
}

export async function resolveExcerptMergeCandidate(
  id: string,
  body: { resolution: ExcerptMergeResolution; reason?: string },
): Promise<ExcerptMergeNodeDto> {
  return postJson<ExcerptMergeNodeDto>(
    `/v1/admin/duplicates/excerpts/${encodeURIComponent(id)}/resolve`,
    body,
  );
}

export interface BulkExcerptMergeDetectPreviewDto {
  unchecked: number;
  alreadyChecked: number;
  withoutEmbedding: number;
  detectorAvailable: boolean;
}

export interface BulkExcerptMergeDetectResultDto {
  scanned: number;
  checked: number;
  excerptMergeCandidatesCreated: number;
  skippedNoEmbedding: number;
  failed: number;
  durationMs: number;
}

export async function previewBulkExcerptMergeDetect(): Promise<BulkExcerptMergeDetectPreviewDto> {
  return getJson<BulkExcerptMergeDetectPreviewDto>(
    '/v1/admin/duplicates/excerpts/bulk-detect/preview',
  );
}

export async function runBulkExcerptMergeDetect(
  limit?: number,
): Promise<BulkExcerptMergeDetectResultDto> {
  return postJson<BulkExcerptMergeDetectResultDto>(
    '/v1/admin/duplicates/excerpts/bulk-detect',
    limit !== undefined ? { limit } : {},
  );
}

// ─── Slice 11 — Topic clustering ─────────────────────────────────────

export type TopicNamingSource = 'haiku' | 'fallback';

export interface TopicNodeDto {
  id: string;
  type: 'Topic';
  props: {
    name: string;
    description: string;
    member_count: number;
    created_at: string;
    updated_at: string;
    naming_source: TopicNamingSource;
  };
}

export interface TopicDetailDto extends TopicNodeDto {
  members: MemorableKnowledgeNode[];
}

export interface TopicReclusterResultDto {
  totalMemoriesScanned: number;
  memoriesWithEmbedding: number;
  topicsDeleted: number;
  topicsCreated: number;
  unclusteredMemories: number;
  haikuCalls: number;
  durationMs: number;
}

export async function listTopics(): Promise<{ items: TopicNodeDto[] }> {
  return getJson<{ items: TopicNodeDto[] }>('/v1/admin/topics');
}

export async function getTopicDetail(id: string): Promise<TopicDetailDto> {
  return getJson<TopicDetailDto>(`/v1/admin/topics/${encodeURIComponent(id)}`);
}

export async function reclusterTopics(opts: {
  similarityThreshold?: number;
  minClusterSize?: number;
} = {}): Promise<TopicReclusterResultDto> {
  return postJson<TopicReclusterResultDto>('/v1/admin/topics/recluster', opts);
}

// -----------------------------------------------------------------------------
// Chat session reset (2026-05-26).
// -----------------------------------------------------------------------------

export interface ResetChatSessionResponse {
  sessionId: string;
  /** New conversation pointer minted by the orchestrator. */
  newConversationId: string;
  resetAt: number;
}

/**
 * Rotates the conversation pointer for a chat session. The backend keeps
 * the session-id stable (so KG / memory references stay valid) but starts
 * a fresh conversation-id so the agent's context window is empty on the
 * next turn. Memory and Knowledge-Graph entries are NOT touched.
 */
export async function resetChatSession(
  sessionId: string,
): Promise<ResetChatSessionResponse> {
  return postJson<ResetChatSessionResponse>(
    `/chat/sessions/${encodeURIComponent(sessionId)}/reset`,
    {},
  );
}

// -----------------------------------------------------------------------------
// Danger Zone — memory purge (destructive). Backed by the admin router at
// /api/v1/admin/memory/purge{/preview}, surfaced to the browser as
// /bot-api/v1/admin/memory/purge{/preview}. Two stages:
//   - POST /preview  → dry-run counts (no writes)
//   - DELETE /        → irreversible purge, gated by a confirm phrase
//
// Axis semantics: 'all' wipes both the agent-scratch (per-agent Turn store)
// and the Knowledge-Graph. The scoped axes (agent/user/team/channel) only
// touch the Knowledge-Graph — the agent-scratch is agent-scoped and is not
// reachable by a user/team/channel selector. The backend surfaces that as a
// `warning` on the response, which the UI renders verbatim.
// -----------------------------------------------------------------------------

export type MemoryPurgeAxis = 'all' | 'agent' | 'user' | 'team' | 'channel';

export interface MemoryPurgePreviewResult {
  scratchCount: number;
  kgCount: number;
  warning?: string;
}

export interface MemoryPurgeResult {
  scratchDeleted: number;
  kgDeleted: number;
  warning?: string;
}

/** Dry-run: count the rows a purge would delete. Never writes. */
export async function previewMemoryPurge(body: {
  axis: MemoryPurgeAxis;
  selector?: string;
}): Promise<MemoryPurgePreviewResult> {
  return postJson<MemoryPurgePreviewResult>(
    '/v1/admin/memory/purge/preview',
    body,
  );
}

/**
 * Irreversible purge. `confirm` must match the phrase the operator typed
 * (`DELETE ALL MEMORY` for axis 'all', otherwise the selector value); the
 * backend re-checks it server-side. `reseed` re-installs the default seed
 * memories after wiping and is only meaningful for axis 'all'.
 */
export async function purgeMemory(body: {
  axis: MemoryPurgeAxis;
  selector?: string;
  confirm: string;
  reseed?: boolean;
}): Promise<MemoryPurgeResult> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi('/v1/admin/memory/purge'), {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
    },
    body: JSON.stringify(body),
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    maybeNavigateToLogin(res.status);
    throw new ApiError(
      res.status,
      `DELETE memory/purge failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as MemoryPurgeResult;
}

// -----------------------------------------------------------------------------
// Memory storage backend switch (filesystem ↔ postgres). Backed by the admin
// router at /api/v1/admin/memory/backend, surfaced to the browser as
// /bot-api/v1/admin/memory/backend. The PUT only PERSISTS the choice — the
// provider swap is applied by the middleware's bootstrap on the NEXT restart.
//   - GET /  → current state + whether a restart is pending
//   - PUT /  → persist a backend choice (postgres requires DATABASE_URL)
// -----------------------------------------------------------------------------

export type MemoryBackend = 'filesystem' | 'postgres';

export interface MemoryBackendState {
  current: MemoryBackend;
  envDefault: string;
  databaseUrlPresent: boolean;
  activeProviderId: string | null;
  restartRequiredToApply: boolean;
}

export interface SetMemoryBackendResult {
  ok: true;
  backend: MemoryBackend;
  restartRequired: true;
}

/** Read the current memory-storage backend and pending-restart state. */
export async function getMemoryBackend(): Promise<MemoryBackendState> {
  return getJson<MemoryBackendState>('/v1/admin/memory/backend');
}

/**
 * Persist the operator's backend choice. Throws `ApiError` (status 400,
 * `body` = `{"error":"database_url_required",...}`) when `postgres` is
 * requested without `DATABASE_URL`; callers surface that inline.
 */
export async function setMemoryBackend(
  backend: MemoryBackend,
): Promise<SetMemoryBackendResult> {
  const forwarded = await forwardCookieHeader();
  const res = await fetch(botApi('/v1/admin/memory/backend'), {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwarded,
    },
    body: JSON.stringify({ backend }),
    credentials: 'include',
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    maybeNavigateToLogin(res.status);
    throw new ApiError(
      res.status,
      `PUT memory/backend failed: ${res.status}`,
      text,
    );
  }
  return JSON.parse(text) as SetMemoryBackendResult;
}

// -----------------------------------------------------------------------------
// One-time memory migration (on-disk /memories → active memoryStore). Backed by
// the admin router at /api/v1/admin/memory/migrate, surfaced to the browser as
// /bot-api/v1/admin/memory/migrate. The SOURCE is always the on-disk
// FilesystemMemoryStore over MEMORY_DIR; the TARGET is the active backend.
// Run once after switching MEMORY_BACKEND to postgres so existing filesystem
// data is not orphaned.
//   - GET /preview → dry-run counts (no writes)
//   - POST /       → execute the copy
// -----------------------------------------------------------------------------

export interface MemoryMigrationPreview {
  totalFiles: number;
  wouldCopy: number;
  alreadyPresent: number;
  note: string;
}

export interface MemoryMigrationResult {
  totalFiles: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
  note: string;
}

/** Dry-run: count how many on-disk files would be copied into the active store. */
export async function previewMemoryMigration(): Promise<MemoryMigrationPreview> {
  return getJson<MemoryMigrationPreview>('/v1/admin/memory/migrate/preview');
}

/** Execute the migration. `overwrite` re-copies files already present in the target. */
export async function runMemoryMigration(
  overwrite?: boolean,
): Promise<MemoryMigrationResult> {
  return postJson<MemoryMigrationResult>(
    '/v1/admin/memory/migrate',
    overwrite === undefined ? {} : { overwrite },
  );
}
