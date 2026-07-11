import { randomBytes } from 'node:crypto';

/**
 * Epic #470 W2 — the GitHub App manifest flow.
 *
 * An operator creates a private GitHub App for the dev platform in one click:
 * the middleware assembles a manifest, the browser form-POSTs it to GitHub,
 * GitHub creates the App and redirects back with a temporary code, and the
 * middleware exchanges that code for the App's credentials (id, PEM, secrets).
 *
 * Mirrors the OAuth broker's pending-flow pattern: an opaque `state`, a TTL'd
 * server-side store, a callback that consumes the flow EXACTLY ONCE. The state is
 * the CSRF gate — an unknown or expired state is rejected without consuming
 * anything, so a replayed callback cannot complete someone else's flow.
 */

/** GitHub caps App names at 34 chars. */
const MAX_APP_NAME = 34;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface ManifestFlowInit {
  createdBySub: string;
  /** Org login for an org-owned App; absent for a personal App. */
  org?: string;
  /** GitHub (or GHES) web origin the form posts to; defaults to github.com. */
  githubBaseUrl?: string;
  /** The App's API base recorded on the resulting row (GHES support). */
  apiBaseUrl?: string;
}

export interface PendingManifestFlow {
  state: string;
  createdBySub: string;
  org?: string;
  apiBaseUrl: string;
  githubBaseUrl: string;
  expiresAt: number;
}

/**
 * Assemble the manifest GitHub converts into an App. `publicBaseUrl` is the
 * operator-facing origin (the same one the OAuth broker uses for its redirects).
 *
 * The webhook is registered but INACTIVE (`active: false`) — it is the W4
 * placeholder (#437): the URL exists so W4 needs no App mutation, but nothing
 * fires. `public: false` makes the App installable only on its owner account.
 */
export function buildManifest(publicBaseUrl: string, orgSuffix?: string): Record<string, unknown> {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const rawName = orgSuffix ? `omadia-dev ${orgSuffix}` : 'omadia-dev';
  return {
    name: rawName.slice(0, MAX_APP_NAME),
    url: base,
    public: false,
    redirect_url: `${base}/bot-api/v1/dev-platform/github-app/callback`,
    setup_url: `${base}/bot-api/v1/dev-platform/github-app/setup`,
    setup_on_update: false,
    hook_attributes: {
      url: `${base}/bot-api/v1/dev-platform/github-app/webhook`,
      active: false,
    },
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    },
    default_events: ['issues'],
  };
}

/**
 * The browser action URL. GitHub requires a FORM POST carrying a single
 * `manifest` field, so the admin UI renders an auto-submitting hidden form whose
 * `action` is this URL.
 */
export function manifestActionUrl(githubBaseUrl: string, state: string, org?: string): string {
  const base = githubBaseUrl.replace(/\/+$/, '');
  const path = org
    ? `/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : '/settings/apps/new';
  return `${base}${path}?state=${encodeURIComponent(state)}`;
}

/**
 * The App credentials GitHub returns from the conversion. Secrets are split at
 * the caller: metadata to Postgres, secret material to Vault.
 */
export interface AppConversion {
  id: number;
  slug: string;
  ownerLogin: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  htmlUrl: string;
}

export type ConversionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetch: ConversionFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/**
 * Exchange the single-use temporary code (1 h expiry) for the App credentials via
 * `POST /app-manifests/{code}/conversions`. Unauthenticated by GitHub's design.
 */
export async function exchangeManifestCode(
  code: string,
  apiBaseUrl: string,
  fetchImpl: ConversionFetch = defaultFetch,
): Promise<AppConversion> {
  const base = apiBaseUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'omadia-dev-platform',
    },
  });
  if (!res.ok) {
    // Never echo the body — it carries the PEM and client secret.
    throw new Error(`GitHub App manifest conversion failed (status ${String(res.status)})`);
  }
  const p = (await res.json()) as Record<string, unknown>;
  const owner = (p['owner'] as Record<string, unknown> | undefined) ?? {};
  const conv: AppConversion = {
    id: Number(p['id']),
    slug: String(p['slug'] ?? ''),
    ownerLogin: String(owner['login'] ?? ''),
    clientId: String(p['client_id'] ?? ''),
    clientSecret: String(p['client_secret'] ?? ''),
    webhookSecret: String(p['webhook_secret'] ?? ''),
    pem: String(p['pem'] ?? ''),
    htmlUrl: String(p['html_url'] ?? ''),
  };
  if (!Number.isInteger(conv.id) || conv.id <= 0 || conv.slug === '' || conv.pem === '') {
    throw new Error('GitHub App manifest conversion returned an incomplete App');
  }
  return conv;
}

/**
 * The TTL'd pending-flow store. Opaque state → the server-side half of one
 * in-flight manifest creation. `consume` returns the flow and removes it, so a
 * state is good for exactly one callback.
 */
export class ManifestFlowStore {
  private readonly flows = new Map<string, PendingManifestFlow>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  start(init: ManifestFlowInit): PendingManifestFlow {
    const state = randomBytes(32).toString('base64url');
    const flow: PendingManifestFlow = {
      state,
      createdBySub: init.createdBySub,
      ...(init.org ? { org: init.org } : {}),
      apiBaseUrl: init.apiBaseUrl ?? 'https://api.github.com',
      githubBaseUrl: init.githubBaseUrl ?? 'https://github.com',
      expiresAt: this.now() + this.ttlMs,
    };
    this.flows.set(state, flow);
    return flow;
  }

  /**
   * Consume a flow by state. Returns null for an unknown OR expired state —
   * WITHOUT consuming anything, so a bad state cannot be probed for existence and
   * an expired flow's slot is simply reaped. The caller maps null → 400.
   */
  consume(state: string): PendingManifestFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    if (flow.expiresAt <= this.now()) {
      this.flows.delete(state);
      return null;
    }
    this.flows.delete(state);
    return flow;
  }

  /** Drop expired flows (call on a timer if desired; consume also self-reaps). */
  prune(): void {
    const t = this.now();
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= t) this.flows.delete(state);
    }
  }

  size(): number {
    return this.flows.size;
  }
}
