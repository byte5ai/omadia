import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';

import { mintAppJwt } from '../devplatform/githubApp/appJwt.js';
import {
  buildManifest,
  exchangeManifestCode,
  manifestActionUrl,
  type AppConversion,
  type ConversionFetch,
  type ManifestFlowStore,
} from '../devplatform/githubApp/manifestFlow.js';
import type {
  DevGithubApp,
  DevGithubAppInstallation,
  DevGithubAppSecrets,
} from '../devplatform/githubApp/appStore.js';
import {
  DevPlatformError,
  handler,
  requireCaller,
} from './devPlatformShared.js';

/**
 * Epic #470 W2 — the GitHub App manifest-flow HTTP routes (spec §2).
 *
 * WHY this file exists: the manifest-flow primitives (`buildManifest`,
 * `manifestActionUrl`, `exchangeManifestCode`, `ManifestFlowStore`) and the App
 * registry (`DevGithubAppStore`) are already built and unit-tested. This file is
 * the thin HTTP seam that drives them — nothing here reimplements their logic.
 *
 * The flow spans TWO mount points with DIFFERENT trust models, so this factory
 * returns TWO routers (see `createDevPlatformGithubAppRouter`):
 *
 *   ADMIN routers (mounted behind `requireAuth` at `/api/v1/admin/dev-platform`):
 *     POST /github-app/manifest/start   — mint a pending flow, hand back the form.
 *     GET  /github-apps                 — list registered Apps (never a secret).
 *     POST /repos/:repoId/credential    — bind a repo to a github_app credential.
 *
 *   PUBLIC router (mounted with NO session at `/bot-api/v1/dev-platform`) — these
 *   are GitHub browser redirects; the opaque `state` token is the only CSRF gate:
 *     GET  /github-app/callback         — consume the flow, exchange, save, 302.
 *     GET  /github-app/setup            — verify the installation, upsert, 302.
 *
 * Every external effect (GitHub HTTP, the flow store, the App store, repo
 * binding, branch-protection recheck) is injected, so the whole surface is
 * exercisable without a network. No handler ever logs or echoes an App key, a
 * client secret, or a webhook secret.
 */

/** The subset of `DevGithubAppStore` the routes touch (structural, for fakes). */
export interface GithubAppStorePort {
  saveApp(conv: AppConversion, apiBaseUrl: string, createdBy: string): Promise<DevGithubApp>;
  listApps(): Promise<Array<DevGithubApp & { installations: number }>>;
  getApp(appRowId: string): Promise<DevGithubApp | null>;
  getSecrets(appId: string): Promise<DevGithubAppSecrets | null>;
  upsertInstallation(
    appRowId: string,
    installationId: string,
    accountLogin: string,
  ): Promise<DevGithubAppInstallation>;
  findInstallation(installationId: string): Promise<DevGithubAppInstallation | null>;
}

export interface DevPlatformGithubAppDeps {
  /** TTL'd pending-flow store (opaque state → the server half of one creation). */
  flowStore: ManifestFlowStore;
  /** The App registry — metadata in Postgres, secrets in Vault. */
  appStore: GithubAppStorePort;
  /** Set `credential_kind='github_app'` + `credential_ref='github_app:<appRowId>:<installationId>'`. */
  bindRepoCredential: (
    repoId: string,
    binding: { appRowId: string; installationId: string },
  ) => Promise<void>;
  /** Resolve a repo's owner/name for the installation-coverage probe. */
  getRepo: (repoId: string) => Promise<{ owner: string; name: string } | null>;
  /** Operator-facing origin (the OAuth broker's origin). Drives the manifest + redirects. */
  publicBaseUrl: string;
  /** GitHub web origin (form-POST target + install page). Default `https://github.com`. */
  githubBaseUrl?: string;
  /** GitHub REST API base. Default `https://api.github.com`. */
  githubApiBaseUrl?: string;
  /** Injected fetch for every GitHub call (JWT verification + code exchange). */
  fetchImpl?: typeof fetch;
  /** Re-run the W0 branch-protection check after binding; returns any warnings. */
  recheckBranchProtection?: (repoId: string) => Promise<string[]>;
  log?: (msg: string) => void;
}

const stripSlash = (s: string): string => s.replace(/\/+$/, '');

function apiHeaders(auth?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'omadia-dev-platform',
    ...(auth ? { Authorization: auth } : {}),
  };
}

/** A GitHub GET authenticated by an App JWT. Returns status + parsed body. */
async function githubGet(
  fetchImpl: typeof fetch,
  url: string,
  jwt: string,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, { method: 'GET', headers: apiHeaders(`Bearer ${jwt}`) });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

export function createDevPlatformGithubAppRouter(deps: DevPlatformGithubAppDeps): {
  admin: Router;
  public: Router;
} {
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? fetch;
  const githubBaseUrl = stripSlash(deps.githubBaseUrl ?? 'https://github.com');
  const githubApiBaseUrl = stripSlash(deps.githubApiBaseUrl ?? 'https://api.github.com');
  const publicBaseUrl = stripSlash(deps.publicBaseUrl);
  // exchangeManifestCode wants a ConversionFetch; adapt the injected fetch once.
  const convFetch: ConversionFetch = (url, init) => fetchImpl(url, init);

  // =========================================================================
  // ADMIN routers — behind requireAuth; requireCaller re-reads the session as
  // defence-in-depth (401 if none). Errors flow through the shared {code,message}.
  // =========================================================================
  const admin = Router();
  admin.use(expressJson({ limit: '64kb' }));

  // --- POST /github-app/manifest/start -------------------------------------
  admin.post(
    '/github-app/manifest/start',
    handler(async (req: Request, res: Response): Promise<void> => {
      const caller = requireCaller(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const org = typeof body['org'] === 'string' && body['org'].length > 0 ? body['org'] : undefined;

      const flow = deps.flowStore.start({
        createdBySub: caller.sub,
        ...(org ? { org } : {}),
        githubBaseUrl,
        apiBaseUrl: githubApiBaseUrl,
      });
      res.json({
        action: manifestActionUrl(flow.githubBaseUrl, flow.state, org),
        manifest: buildManifest(publicBaseUrl, org),
      });
    }),
  );

  // --- GET /github-apps ----------------------------------------------------
  admin.get(
    '/github-apps',
    handler(async (req: Request, res: Response): Promise<void> => {
      requireCaller(req);
      const apps = await deps.appStore.listApps();
      // Project only browser-safe metadata — the store never returns secrets, and
      // this shape (spec §9) keeps it that way even as the row grows.
      res.json({
        apps: apps.map((a) => ({
          appId: a.appId,
          slug: a.slug,
          ownerLogin: a.ownerLogin,
          htmlUrl: a.htmlUrl,
          installations: a.installations,
        })),
      });
    }),
  );

  // --- POST /repos/:repoId/credential --------------------------------------
  admin.post(
    '/repos/:repoId/credential',
    handler(async (req: Request, res: Response): Promise<void> => {
      requireCaller(req);
      const repoId = typeof req.params['repoId'] === 'string' ? req.params['repoId'] : '';
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body['kind'] !== 'github_app') {
        throw new DevPlatformError(400, 'devplatform.invalid_credential_kind', "kind must be 'github_app'");
      }
      const installationId =
        typeof body['installationId'] === 'string' && body['installationId'].length > 0
          ? body['installationId']
          : '';
      if (!installationId) {
        throw new DevPlatformError(400, 'devplatform.invalid_installation', 'installationId is required');
      }

      const repo = await deps.getRepo(repoId);
      if (!repo) throw new DevPlatformError(404, 'devplatform.repo_not_found', 'no such repo');

      // The installation must already be known (its setup callback ran) so we can
      // find the App that owns it and mint its JWT.
      const installation = await deps.appStore.findInstallation(installationId);
      if (!installation) {
        throw new DevPlatformError(400, 'devplatform.unknown_installation', 'installation is not registered');
      }
      const app = await deps.appStore.getApp(installation.appRowId);
      const secrets = app ? await deps.appStore.getSecrets(app.appId) : null;
      if (!app || !secrets) {
        throw new DevPlatformError(400, 'devplatform.app_unusable', 'the App backing this installation is unusable');
      }

      // Coverage proof: the installation must actually cover THIS repo, and the
      // covering installation id must equal the one being bound.
      const jwt = mintAppJwt(app.appId, secrets.privateKey);
      const probe = await githubGet(
        fetchImpl,
        `${stripSlash(app.apiBaseUrl)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
        jwt,
      );
      if (!probe.ok || String(probe.body['id'] ?? '') !== installationId) {
        throw new DevPlatformError(
          400,
          'devplatform.installation_not_covering',
          'the installation does not cover this repository',
        );
      }

      await deps.bindRepoCredential(repoId, {
        appRowId: installation.appRowId,
        installationId,
      });

      const warnings = deps.recheckBranchProtection ? await deps.recheckBranchProtection(repoId) : [];
      res.json({ ok: true, warnings });
    }),
  );

  // =========================================================================
  // PUBLIC router — GitHub redirects, NO session. The `state` token is the CSRF
  // gate. Errors render a neutral text page (never HTML, never a secret).
  // =========================================================================
  const pub = Router();

  const errorPage = (res: Response, status: number, message: string): void => {
    if (res.headersSent) return;
    res.status(status).type('text/plain').send(message);
  };

  // --- GET /github-app/callback?code&state ---------------------------------
  pub.get('/github-app/callback', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';

      // consume() removes an unknown/expired flow's slot but returns null for it —
      // a bad state completes nothing (CSRF gate). Nothing downstream runs.
      const flow = state ? deps.flowStore.consume(state) : null;
      if (!flow) {
        errorPage(res, 400, 'This GitHub App setup link is invalid or has expired. Start again from the admin dashboard.');
        return;
      }
      if (!code) {
        errorPage(res, 400, 'GitHub returned no App code. Start again from the admin dashboard.');
        return;
      }

      let conv: AppConversion;
      try {
        conv = await exchangeManifestCode(code, flow.apiBaseUrl, convFetch);
      } catch (err) {
        // The conversion body carries the PEM + secrets — NEVER log or echo it.
        log(`[dev-platform] manifest conversion failed: ${err instanceof Error ? err.message : 'error'}`);
        errorPage(res, 502, 'GitHub could not create the App. Please start again from the admin dashboard.');
        return;
      }

      try {
        await deps.appStore.saveApp(conv, flow.apiBaseUrl, flow.createdBySub);
      } catch (err) {
        // Row + Vault write is atomic in the store; if it failed the App exists on
        // GitHub but we hold no credentials — tell the operator to delete the orphan.
        log(`[dev-platform] App save failed after conversion`);
        void err;
        errorPage(
          res,
          500,
          `The GitHub App was created but could not be saved. Delete the orphaned App at ${conv.htmlUrl} and re-run setup.`,
        );
        return;
      }

      // Same-session install: send the operator straight to the install page.
      res.redirect(302, `${flow.githubBaseUrl}/apps/${encodeURIComponent(conv.slug)}/installations/new`);
    })().catch((err) => {
      log(`[dev-platform] callback failed: ${err instanceof Error ? err.message : String(err)}`);
      errorPage(res, 500, 'Something went wrong completing GitHub App setup.');
    });
  });

  // --- GET /github-app/setup?installation_id&setup_action ------------------
  pub.get('/github-app/setup', (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
      const installationId =
        typeof req.query['installation_id'] === 'string' ? req.query['installation_id'] : '';
      if (!installationId) {
        errorPage(res, 400, 'GitHub did not supply an installation id.');
        return;
      }

      // Verify the installation belongs to a known App: mint each App's JWT and ask
      // GitHub for the installation. Only the owning App gets a 200.
      const apps = await deps.appStore.listApps();
      let owned: { appRowId: string; accountLogin: string } | null = null;
      for (const app of apps) {
        const secrets = await deps.appStore.getSecrets(app.appId);
        if (!secrets) continue;
        const jwt = mintAppJwt(app.appId, secrets.privateKey);
        const probe = await githubGet(
          fetchImpl,
          `${stripSlash(app.apiBaseUrl)}/app/installations/${encodeURIComponent(installationId)}`,
          jwt,
        );
        if (probe.ok) {
          const account = (probe.body['account'] as Record<string, unknown> | undefined) ?? {};
          owned = { appRowId: app.id, accountLogin: String(account['login'] ?? '') };
          break;
        }
      }
      if (!owned) {
        errorPage(res, 400, 'This installation does not belong to a known GitHub App.');
        return;
      }

      await deps.appStore.upsertInstallation(owned.appRowId, installationId, owned.accountLogin);
      res.redirect(302, `${publicBaseUrl}/admin/dev-platform?installed=${encodeURIComponent(installationId)}`);
    })().catch((err) => {
      log(`[dev-platform] setup failed: ${err instanceof Error ? err.message : String(err)}`);
      errorPage(res, 500, 'Something went wrong recording the GitHub App installation.');
    });
  });

  return { admin, public: pub };
}
