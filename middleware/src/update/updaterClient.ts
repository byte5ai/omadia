/**
 * Client for the updater sidecar (#432, slice 4) — the only component allowed
 * to touch the Docker Engine API.
 *
 * The middleware never speaks to the Docker socket itself, and that separation
 * is the whole security argument for option D: a socket (even a proxied one) is
 * host-root-equivalent, so it is reachable only from a sidecar with no
 * published port, no inbound route from the browser, and a shared bearer token.
 * If `OMADIA_UPDATER_URL` is unset the product runs in notify-only mode — the
 * admin page still reports versions and flags a newer release, it just cannot
 * execute anything.
 *
 * Wire contract mirrored in `middleware/sidecars/updater/README.md`.
 */

export type UpdaterState =
  | 'idle'
  | 'updating'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

/** Which of the job's numbered steps is running — see
 *  `sidecars/updater/src/updateJob.mjs`. Absent on an older sidecar. */
export type UpdaterPhase =
  | 'resolve'
  | 'preflight'
  | 'pin'
  | 'replace'
  | 'health_gate'
  | 'rollback'
  | 'done';

/** Structured reason for a `failed` / `rolled_back` outcome, so the admin
 *  page can explain it without parsing the English `error` string. */
export type UpdaterFailure =
  | {
      readonly kind: 'health_gate';
      /** `never_reachable` | `version_never_matched` (health.mjs verdicts). */
      readonly reason: string;
      readonly observedVersion: string | null;
    }
  | { readonly kind: 'replace'; readonly service: string | null };

export interface UpdaterStatus {
  readonly state: UpdaterState;
  readonly targetVersion: string | null;
  readonly previousVersion: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  /** Human-readable progress trail, newest last. */
  readonly steps: readonly string[];
  /** Current job step; null while idle. Absent on an older sidecar. */
  readonly phase?: UpdaterPhase | null;
  /** Why the last job did not land; null otherwise. Absent on an older sidecar. */
  readonly failure?: UpdaterFailure | null;
  /** Which executor the sidecar runs (#696). Absent on an older sidecar. */
  readonly engine?: 'docker' | 'fly';
  /**
   * Whether the chosen version survives the operator's next routine deploy.
   * False on Fly: `fly deploy` reads the operator's local `fly.toml` and
   * nothing server-side overrides it, so a later plain deploy reverts the app.
   * Surfaced rather than hidden — the operator has to update that file too.
   */
  readonly pinPersisted?: boolean;
}

/** One service's verdict from the read-only image check. */
export interface UpdaterImageCheck {
  readonly service: string;
  readonly currentImage: string;
  /** The image the update WOULD use, e.g. `ghcr.io/.../middleware:v0.140.1`. */
  readonly image: string;
  readonly available: boolean;
  /** Registry verdict when unavailable — `tag_not_found`, `registry_status_…`,
   *  `registry_unreachable: …`. Null when available. */
  readonly reason: string | null;
}

export interface UpdaterPreflight {
  readonly targetVersion: string;
  /** True only when every service's image is present. */
  readonly ok: boolean;
  readonly images: readonly UpdaterImageCheck[];
}

export interface UpdaterClient {
  /** Never rejects — an unreachable sidecar is a normal state to render. */
  getStatus(): Promise<
    { ok: true; status: UpdaterStatus } | { ok: false; error: string }
  >;
  /** Read-only: does every image for `targetVersion` exist in the registry?
   *  Pulls nothing and touches no container. Absent on an older sidecar, which
   *  answers 404 — surfaced as `ok:false` so the UI can say "cannot check"
   *  rather than "not available". */
  preflight(
    targetVersion: string,
  ): Promise<
    { ok: true; result: UpdaterPreflight } | { ok: false; error: string; status?: number }
  >;
  /** Ask the sidecar to move the stack to `targetVersion`. Resolves as soon as
   *  the sidecar has ACCEPTED the job; the update itself outlives this call
   *  (and this process). */
  requestUpdate(
    targetVersion: string,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }>;
}

export interface UpdaterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export function createUpdaterClient(
  options: UpdaterClientOptions,
): UpdaterClient {
  const base = normalizeBase(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: text.length > 0 ? text.slice(0, 500) : `http_${res.status}`,
          status: res.status,
        };
      }
      return { ok: true, body: text.length > 0 ? JSON.parse(text) : {} };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getStatus() {
      const res = await call('/status', { method: 'GET' });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, status: res.body as UpdaterStatus };
    },

    async preflight(targetVersion) {
      const res = await call(
        `/preflight?targetVersion=${encodeURIComponent(targetVersion)}`,
        { method: 'GET' },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          ...(res.status !== undefined ? { status: res.status } : {}),
        };
      }
      return { ok: true, result: res.body as UpdaterPreflight };
    },

    async requestUpdate(targetVersion) {
      const res = await call('/update', {
        method: 'POST',
        body: JSON.stringify({ targetVersion }),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          ...(res.status !== undefined ? { status: res.status } : {}),
        };
      }
      return { ok: true };
    },
  };
}
