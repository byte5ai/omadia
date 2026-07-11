/**
 * Epic #470 W0 — repo onboarding, device-flow and issues routes for the dev
 * platform admin API (spec §6/§7/§9). Split out of `devPlatform.ts` to keep both
 * files under the 500-line limit; the factory in `devPlatform.ts` calls
 * `registerDevPlatformRepoRoutes` and owns the job routes + SSE.
 *
 * Credential-isolation contract, enforced here:
 *   - A repo's token (device-flow OAuth or PAT) is written to the Vault via the
 *     injected credential store and is NEVER returned to the browser. Every
 *     response carries only a credential STATUS (`{ kind, login, isSet }`).
 *   - The device-flow `device_code` stays server-side (in `DeviceFlowStore`);
 *     the browser only ever sees `{ userCode, verificationUri, expiresIn,
 *     interval }` on start and `{ status, login? }` on poll.
 *   - Access-probe / branch-protection failures never echo an upstream body —
 *     GitHub can reflect the bearer token in an error.
 */

import type { Router, Request } from 'express';

import type { DevRepo, DevRepoCredentialKind, NewDevRepo } from '../devplatform/types.js';
import {
  DevPlatformError,
  defaultCheckBranchProtection,
  handler,
  readParam,
  requireCaller,
  toRepoView,
  type DevPlatformRouterDeps,
} from './devPlatformShared.js';

const DEFAULT_ISSUES_LIMIT = 30;
const DEFAULT_DEVICE_SCOPES = ['repo'] as const;

export function registerDevPlatformRepoRoutes(router: Router, deps: DevPlatformRouterDeps): void {
  const log = deps.log ?? (() => {});
  const cloneUrlFor =
    deps.cloneUrlFor ?? ((owner: string, name: string) => `https://github.com/${owner}/${name}.git`);
  const checkBranchProtection =
    deps.checkBranchProtection ??
    ((input) => defaultCheckBranchProtection(input));

  // --- GET /repos -----------------------------------------------------------
  router.get(
    '/repos',
    handler(async (req, res) => {
      requireCaller(req);
      const repos = await deps.repoStore.listRepos();
      const views = await Promise.all(
        repos.map(async (repo) => toRepoView(repo, await deps.credentials.getConnection(repo.id))),
      );
      res.json({ repos: views });
    }),
  );

  // --- POST /repos ----------------------------------------------------------
  router.post(
    '/repos',
    handler(async (req, res) => {
      const caller = requireCaller(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const owner = asString(body['owner']);
      const name = asString(body['name']);
      if (!owner || !name) throw new DevPlatformError(400, 'devplatform.invalid_repo', 'owner and name are required');

      const cred = (body['credential'] ?? {}) as Record<string, unknown>;
      const kind = cred['kind'];
      if (kind !== 'device_flow' && kind !== 'pat') {
        throw new DevPlatformError(400, 'devplatform.invalid_credential', "credential.kind must be 'device_flow' or 'pat'");
      }

      // Resolve the raw token to validate access with (never returned).
      let token: string | undefined;
      if (kind === 'device_flow') {
        token = await deps.credentials.resolvePending(caller.sub);
        if (!token) {
          throw new DevPlatformError(400, 'devplatform.no_pending_device_flow', 'no device-flow authorization is staged; connect first');
        }
      } else {
        token = asString(cred['token']);
        if (!token) throw new DevPlatformError(400, 'devplatform.invalid_credential', 'a PAT credential needs a token');
      }

      // Validate access + capture the default branch (spec §6).
      const access = await deps.probeRepoAccess({ owner, name, token });
      if (!access.ok) {
        // Drop the staged device-flow token: it was parked under pending/<sub>
        // and, without this, a failed repo add leaves a live credential in the
        // vault staging slot with no owning repo to clean it up.
        if (kind === 'device_flow') await deps.credentials.clearPending(caller.sub);
        throw new DevPlatformError(400, 'devplatform.repo_access_failed', 'could not access the repository with the supplied credential');
      }

      const credentialKind: DevRepoCredentialKind = kind === 'device_flow' ? 'device_flow' : 'pat';
      const newRepo: NewDevRepo = {
        owner,
        name,
        cloneUrl: cloneUrlFor(owner, name),
        defaultBranch: access.defaultBranch || 'main',
        credentialKind,
        // `repo/<id>` is only known post-insert; patched immediately below.
        credentialRef: 'repo/pending',
        createdBy: caller.sub,
      };
      const trackerKind = asString(body['trackerKind']);
      if (trackerKind) newRepo.trackerKind = trackerKind;
      if (typeof body['runsTests'] === 'boolean') newRepo.runsTests = body['runsTests'];
      const allowedLaunchers = asStringArray(body['allowedLaunchers']);
      if (allowedLaunchers) newRepo.allowedLaunchers = allowedLaunchers;

      const created = await deps.repoStore.createRepo(newRepo);
      await deps.repoStore.updateRepo(created.id, { credentialRef: `repo/${created.id}` });

      // Move the validated token into place (spec §6).
      if (kind === 'device_flow') {
        await deps.credentials.promotePending(caller.sub, created.id, access.login);
      } else {
        await deps.credentials.save(created.id, { token, kind: 'pat', login: access.login });
      }

      // Branch-protection check with the now-stored credential (spec §6).
      const stored = await deps.credentials.resolve(created.id);
      if (stored) {
        try {
          const bp = await checkBranchProtection({ owner, repo: name, branch: newRepo.defaultBranch ?? 'main', token: stored });
          await deps.repoStore.setBranchProtection(created.id, bp.ok);
        } catch {
          // A protection-check failure must not fail onboarding — leave it null
          // (unknown), the operator can re-run POST /repos/:id/check.
          await deps.repoStore.setBranchProtection(created.id, null);
        }
      }

      const repo = (await deps.repoStore.getRepo(created.id)) ?? created;
      const conn = await deps.credentials.getConnection(created.id);
      log(`[dev-platform] repo ${owner}/${name} onboarded (${credentialKind}) by ${caller.sub}`);
      res.status(201).json(toRepoView(repo, conn));
    }),
  );

  // --- GET /repos/:id -------------------------------------------------------
  router.get(
    '/repos/:id',
    handler(async (req, res) => {
      requireCaller(req);
      const repo = await loadRepo(deps, req);
      res.json(toRepoView(repo, await deps.credentials.getConnection(repo.id)));
    }),
  );

  // --- PATCH /repos/:id -----------------------------------------------------
  // Mutable knobs only — never `credentialKind`/`credentialRef` (those move via
  // the onboarding flow, not a free-form patch).
  router.patch(
    '/repos/:id',
    handler(async (req, res) => {
      requireCaller(req);
      const repo = await loadRepo(deps, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Partial<NewDevRepo> = {};
      if ('trackerKind' in body) patch.trackerKind = asString(body['trackerKind']) || null;
      if (typeof body['runsTests'] === 'boolean') patch.runsTests = body['runsTests'];
      const launchers = asStringArray(body['allowedLaunchers']);
      if (launchers) patch.allowedLaunchers = launchers;
      const triggers = asStringArray(body['allowedTriggers']);
      if (triggers) patch.allowedTriggers = triggers;
      if (typeof body['defaultBranch'] === 'string' && body['defaultBranch'].trim()) {
        patch.defaultBranch = body['defaultBranch'].trim();
      }
      if (typeof body['webhookEnabled'] === 'boolean') patch.webhookEnabled = body['webhookEnabled'];
      if ('budgetCostUsd' in body) patch.budgetCostUsd = parseNullableBudget(body['budgetCostUsd']);
      const updated = (await deps.repoStore.updateRepo(repo.id, patch)) ?? repo;
      res.json(toRepoView(updated, await deps.credentials.getConnection(updated.id)));
    }),
  );

  // --- DELETE /repos/:id ----------------------------------------------------
  // Purges all Vault keys before dropping the row (spec §9).
  router.delete(
    '/repos/:id',
    handler(async (req, res) => {
      requireCaller(req);
      const id = readParam(req, 'id');
      if (!id) throw new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id');
      const repo = await deps.repoStore.getRepo(id);
      if (!repo) throw new DevPlatformError(404, 'devplatform.repo_not_found', 'no such repository');
      await deps.credentials.clear(id);
      await deps.repoStore.deleteRepo(id);
      log(`[dev-platform] repo ${repo.owner}/${repo.name} deleted`);
      res.status(204).end();
    }),
  );

  // --- POST /repos/:id/check ------------------------------------------------
  router.post(
    '/repos/:id/check',
    handler(async (req, res) => {
      requireCaller(req);
      const repo = await loadRepo(deps, req);
      const token = await deps.credentials.resolve(repo.id);
      if (!token) {
        res.json({ access: false, branchProtection: null });
        return;
      }
      const access = await deps.probeRepoAccess({ owner: repo.owner, name: repo.name, token });
      let branchProtection: boolean | null = null;
      if (access.ok) {
        const bp = await checkBranchProtection({
          owner: repo.owner,
          repo: repo.name,
          branch: repo.defaultBranch,
          token,
        });
        branchProtection = bp.ok;
        await deps.repoStore.setBranchProtection(repo.id, bp.ok);
      }
      res.json({ access: access.ok, branchProtection });
    }),
  );

  // --- GET /repos/:id/issues ------------------------------------------------
  router.get(
    '/repos/:id/issues',
    handler(async (req, res) => {
      requireCaller(req);
      const repo = await loadRepo(deps, req);
      const token = await deps.credentials.resolve(repo.id);
      if (!token) throw new DevPlatformError(409, 'devplatform.repo_not_connected', 'repository has no stored credential');
      const limit = clampLimit(req.query['limit'], DEFAULT_ISSUES_LIMIT);
      const tracker = deps.makeIssuesTracker({ owner: repo.owner, name: repo.name, token });
      const tickets = await tracker.listOpenTickets({ limit });
      res.json({
        issues: tickets.map((t) => ({
          number: t.number,
          title: t.title,
          labels: t.labels,
          htmlUrl: t.htmlUrl,
          authorLogin: t.authorLogin,
        })),
      });
    }),
  );

  // --- POST /github/connect/start (device flow) -----------------------------
  router.post(
    '/github/connect/start',
    handler(async (req, res) => {
      const caller = requireCaller(req);
      const df = deps.deviceFlow;
      if (!df) {
        throw new DevPlatformError(503, 'devplatform.device_flow_unconfigured', 'device-flow onboarding is not configured');
      }
      const scopes = df.scopes ?? DEFAULT_DEVICE_SCOPES;
      const dc = await df.provider.requestDeviceCode(scopes);
      // The device_code is the secret half — it stays server-side.
      df.store.start(caller.sub, dc.deviceCode, dc.interval, dc.expiresIn);
      res.json({
        userCode: dc.userCode,
        verificationUri: dc.verificationUri,
        expiresIn: dc.expiresIn,
        interval: dc.interval,
      });
    }),
  );

  // --- POST /github/connect/poll --------------------------------------------
  router.post(
    '/github/connect/poll',
    handler(async (req, res) => {
      const caller = requireCaller(req);
      const df = deps.deviceFlow;
      if (!df) {
        throw new DevPlatformError(503, 'devplatform.device_flow_unconfigured', 'device-flow onboarding is not configured');
      }
      const flow = df.store.get(caller.sub);
      if (!flow) {
        res.json({ status: 'expired' });
        return;
      }
      if (df.store.isTooSoon(caller.sub)) {
        res.json({ status: 'pending' });
        return;
      }
      df.store.markPolled(caller.sub);
      const result = await df.provider.pollAccessToken(flow.deviceCode);
      switch (result.status) {
        case 'authorized': {
          let login = '';
          try {
            login = await df.provider.fetchUserLogin(result.accessToken);
          } catch {
            // non-fatal — the token works without a display handle.
          }
          // Park the token until POST /repos names the repo (spec §6).
          await deps.credentials.stashPending(caller.sub, result.accessToken);
          df.store.delete(caller.sub);
          res.json({ status: 'authorized', login: login || null });
          return;
        }
        case 'slow_down':
          df.store.bumpInterval(caller.sub, result.interval);
          res.json({ status: 'pending', interval: result.interval });
          return;
        case 'pending':
          res.json({ status: 'pending' });
          return;
        case 'expired':
          df.store.delete(caller.sub);
          res.json({ status: 'expired' });
          return;
        case 'denied':
          df.store.delete(caller.sub);
          res.json({ status: 'denied' });
          return;
        default:
          res.json({ status: 'error' });
          return;
      }
    }),
  );
}

// ---------------------------------------------------------------------------

async function loadRepo(deps: DevPlatformRouterDeps, req: Request): Promise<DevRepo> {
  const id = readParam(req, 'id');
  if (!id) throw new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id');
  const repo = await deps.repoStore.getRepo(id);
  if (!repo) throw new DevPlatformError(404, 'devplatform.repo_not_found', 'no such repository');
  return repo;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The per-repo cost budget knob (W4 spec §5): a strictly-positive number, or
 *  null to clear (fall back to the config default). Rejects zero/negative/NaN so
 *  an operator typo cannot silently disable a cap. */
function parseNullableBudget(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new DevPlatformError(
      400,
      'devplatform.invalid_budget',
      'budget must be a positive number or null',
    );
  }
  return n;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function clampLimit(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}
