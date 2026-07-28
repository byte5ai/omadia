/**
 * Epic #470 W4 — inbound GitHub webhook trigger (`POST /api/webhooks/github`, spec §3).
 *
 * MOUNTING CONTRACT (the index unit wires this): this router MUST be mounted BEFORE
 * the global `app.use(express.json(...))`. HMAC verification needs the RAW request
 * bytes; once `express.json` has parsed and re-serialised the body, those bytes are
 * gone and every signature check fails. The router attaches its OWN
 * `express.raw` parser (type any, 512kb limit) at the route level, so it consumes
 * only this one path and never other routers' bodies. There is NO `requireAuth`:
 * the signature IS the authentication.
 *
 * ORDER OF OPERATIONS is security-critical and deliberate:
 *   1. Verify the signature FIRST, before trusting ANY payload field. Multiple
 *      registered Apps ⇒ iterate the stored secrets, accept on first match.
 *   2. Atomically CLAIM the delivery GUID (dedupe) before doing any work.
 *   3. Filter (event/action/label), authorize (repo opt-in, sender allowlist,
 *      rate limits), dedupe (active job), then create the job.
 *
 * Every claimed delivery finalizes exactly one `outcome` in `dev_webhook_deliveries`
 * — a silent drop is impossible. A valid-signature delivery that is merely noise
 * (wrong label, disabled repo, …) always answers 2xx: GitHub retries 4xx/5xx, so a
 * 4xx on noise would turn every ignored label into a redelivery storm. The only
 * 4xx is 401 for a bad/absent signature.
 */

import crypto from 'node:crypto';

import express, { Router } from 'express';
import type { Request, Response } from 'express';

import type { DevRepo, RunnerBackendKind } from '../devplatform/types.js';
import type { CreateTriggerJobInput, CreateTriggerJobResult } from '../devplatform/triggers/triggerJobService.js';
import type { WebhookDeliveryOutcome } from '../devplatform/triggers/webhookDeliveryStore.js';

const RAW_BODY_LIMIT = '512kb';
const ONE_HOUR_MS = 3_600_000;

/** The GitHub `issues` webhook fields this route reads (a minimal subset). */
interface GithubIssuesPayload {
  action?: unknown;
  label?: { name?: unknown } | null;
  issue?: { number?: unknown; title?: unknown; body?: unknown } | null;
  repository?: { full_name?: unknown } | null;
  sender?: { login?: unknown } | null;
}

export interface DevWebhooksRepoLookup {
  getByFullName(fullName: string): Promise<DevRepo | null>;
}

export interface DevWebhooksDeliveryStore {
  claim(input: {
    deliveryId: string;
    event: string | null;
    repo: string | null;
    issueNumber: number | null;
    sender: string | null;
  }): Promise<boolean>;
  setOutcome(deliveryId: string, outcome: WebhookDeliveryOutcome): Promise<void>;
  /** Atomic per-repo rate-limit reservation (replaces the count→create TOCTOU).
   *  Serialises admission on a per-repo advisory lock and COMMITs the reservation
   *  as `job_created` before releasing it, so concurrent deliveries count it. */
  reserveJobSlot(input: {
    repo: string;
    sender: string;
    deliveryId: string;
    repoLimit: number;
    senderLimit: number;
    sinceIso: string;
  }): Promise<{ admitted: boolean; reason?: 'rate_limited' }>;
  hasPriorJob(repo: string, sender: string): Promise<boolean>;
}

export interface DevWebhooksRouterDeps {
  /** All registered Apps' webhook secrets (Vault-backed). Verified before any
   *  payload field is trusted; accept on first HMAC match. */
  listWebhookSecrets: () => Promise<readonly string[]>;
  repos: DevWebhooksRepoLookup;
  deliveries: DevWebhooksDeliveryStore;
  /** True iff a non-terminal `source='webhook'` job already exists for repo + ref. */
  hasActiveWebhookJob: (repoId: string, sourceRef: string) => Promise<boolean>;
  /** The structural-policy job-creation seam (`triggerJobService.createTriggerJob`). */
  createTriggerJob: (input: CreateTriggerJobInput) => Promise<CreateTriggerJobResult>;
  /** Mint the one-time runner token; only the hash is persisted. */
  mintRunnerToken: () => { token: string; hash: string };
  /** Backend assigned to webhook jobs. `'local'` is structurally refused by the
   *  job service — never selected in production. */
  webhookBackend: RunnerBackendKind;
  /** Global kill switch (`DEV_WEBHOOKS_ENABLED`). */
  webhooksEnabled: boolean;
  maxJobsPerRepoHour: number;
  maxJobsPerSenderHour: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Constant-time GitHub signature check over the RAW body. `sha256=<hex>`; a
 *  missing/short/mismatched header returns false. Length is guarded before
 *  `timingSafeEqual`, which throws on unequal-length buffers. */
function verifyGithubSignature(rawBody: Buffer, header: string | undefined, secrets: readonly string[]): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const received = Buffer.from(header);
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`);
    if (expected.length === received.length && crypto.timingSafeEqual(expected, received)) {
      return true;
    }
  }
  return false;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function createDevWebhooksRouter(deps: DevWebhooksRouterDeps): Router {
  const router = Router();
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;

  router.post('/api/webhooks/github', express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }), (req: Request, res: Response) => {
    void handleGithubWebhook(deps, log, now, req, res).catch((err: unknown) => {
      log(`[dev-webhooks] handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.status(500).json({ code: 'webhook.internal' });
    });
  });

  return router;
}

async function handleGithubWebhook(
  deps: DevWebhooksRouterDeps,
  log: (msg: string) => void,
  now: () => number,
  req: Request,
  res: Response,
): Promise<void> {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // 1. Signature FIRST — before trusting any field.
  const secrets = await deps.listWebhookSecrets();
  if (!verifyGithubSignature(raw, req.header('x-hub-signature-256'), secrets)) {
    // No detail leaked, and NOTHING recorded: the payload is unverified, so its
    // delivery-id / repo / sender are attacker-forgeable and must not be stored.
    res.status(401).json({ code: 'webhook.bad_signature' });
    return;
  }

  // 2. Parse the now-trusted payload.
  let payload: GithubIssuesPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as GithubIssuesPayload;
  } catch {
    res.status(202).json({ ok: true, outcome: 'dropped_event' });
    return;
  }

  const deliveryId = req.header('x-github-delivery') ?? '';
  const event = req.header('x-github-event') ?? null;
  const action = asString(payload.action);
  const repoFullName = asString(payload.repository?.full_name);
  const issueNumber = typeof payload.issue?.number === 'number' ? payload.issue.number : null;
  const sender = asString(payload.sender?.login);
  const labelName = asString(payload.label?.name);

  if (!deliveryId) {
    // No GUID → cannot dedupe or audit. Signed but malformed; drop without retry.
    res.status(202).json({ ok: true, outcome: 'dropped_event' });
    return;
  }

  // 3. Atomically claim the delivery GUID (dedupe). A redelivery loses the race.
  const claimed = await deps.deliveries.claim({ deliveryId, event, repo: repoFullName, issueNumber, sender });
  if (!claimed) {
    res.status(202).json({ ok: true, outcome: 'duplicate' });
    return;
  }

  // From here we OWN the row: every branch finalizes exactly one outcome.
  const finish = async (
    outcome: WebhookDeliveryOutcome,
    status = 202,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await deps.deliveries.setOutcome(deliveryId, outcome);
    if (!res.headersSent) res.status(status).json({ ok: true, outcome, ...extra });
  };

  // 4. Global kill switch.
  if (!deps.webhooksEnabled) return finish('disabled');

  // 5. Event filter — issues/labeled only. Everything else is valid-signature noise.
  if (event !== 'issues' || action !== 'labeled') return finish('dropped_event');

  // 6. Resolve the repo; it must have opted into webhook triggers.
  const repo = repoFullName ? await deps.repos.getByFullName(repoFullName) : null;
  if (!repo || !repo.allowedTriggers.includes('webhook')) return finish('dropped_repo');

  // 7. Per-repo kill switch.
  if (!repo.webhookEnabled) return finish('disabled');

  // 8. Label must match the repo's trigger label.
  if (labelName !== repo.triggerLabel) return finish('dropped_label');

  // 9. Need an issue number and a sender to go further.
  if (issueNumber === null || !sender || !repoFullName) return finish('dropped_event');

  // 10. Sender allowlist (empty ⇒ webhook triggers off for the repo).
  if (!repo.webhookSenders.includes(sender)) return finish('refused_sender');

  // 11. Active-job dedupe (label remove/re-add spam).
  const sourceRef = `${repoFullName}#${issueNumber}`;
  if (await deps.hasActiveWebhookJob(repo.id, sourceRef)) return finish('deduped_active_job');

  // 12. First job from a not-yet-seen (repo, sender) pair → human gate before the
  //     agent runs. Computed BEFORE the slot reservation on purpose: the
  //     reservation stamps THIS delivery `job_created`, and `hasPriorJob` counts
  //     `job_created` rows — so reserving first would make a delivery see its own
  //     row and skip its own first-source gate.
  const requireGate = !(await deps.deliveries.hasPriorJob(repoFullName, sender));

  // 13. Rate limits — per-repo AND per-sender over the last rolling hour, enforced
  //     as an ATOMIC reservation. A per-repo advisory lock serialises admission and
  //     the reserved slot is committed as `job_created` while the lock is held, so
  //     concurrent deliveries count it — closing the count→create→setOutcome TOCTOU
  //     that let N racing deliveries all pass a cap of 2 (Forge W4 concurrency #1).
  const sinceIso = new Date(now() - ONE_HOUR_MS).toISOString();
  const reservation = await deps.deliveries.reserveJobSlot({
    repo: repoFullName,
    sender,
    deliveryId,
    repoLimit: deps.maxJobsPerRepoHour,
    senderLimit: deps.maxJobsPerSenderHour,
    sinceIso,
  });
  if (!reservation.admitted) return finish('rate_limited');

  // 14. Create the job through the structural-policy service. The brief is HOSTILE
  //     issue text passed through UNCHANGED — the W3 policy engine is the guard,
  //     not this route. Structural refusals (local backend, non-github_app) return
  //     `refused_policy` and create no job.
  const title = typeof payload.issue?.title === 'string' ? payload.issue.title : '';
  const body = typeof payload.issue?.body === 'string' ? payload.issue.body : '';
  const minted = deps.mintRunnerToken();
  const result = await deps.createTriggerJob({
    repo,
    backend: deps.webhookBackend,
    kind: 'fix_issue',
    brief: `${title}\n\n${body}`,
    sourceRef,
    source: 'webhook',
    createdBy: 'webhook:github',
    runnerTokenHash: minted.hash,
    requireGate,
    senderLogin: sender,
  });

  // A structural refusal or a same-issue dedupe (the 0028 unique index caught a
  // concurrent create) corrects this delivery's reserved `job_created` slot to its
  // real terminal outcome — freeing the slot for the next window count.
  if (result.decision === 'refused_policy') {
    log(`[dev-webhooks] ${repoFullName}#${issueNumber} refused_policy: ${result.reason ?? ''}`);
    return finish('refused_policy');
  }
  if (result.decision === 'deduped_active_job') {
    log(`[dev-webhooks] ${repoFullName}#${issueNumber} deduped_active_job (unique index)`);
    return finish('deduped_active_job');
  }
  log(`[dev-webhooks] job ${result.job?.id ?? '?'} created for ${sourceRef} (gated=${result.gated})`);
  return finish('job_created', 201, { jobId: result.job?.id, gated: result.gated });
}
