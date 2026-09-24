/**
 * The TENANT-wide Teams sign-in surface (byte5ai/omadia#924).
 *
 * WHY ITS OWN ROUTER, AND NOT `/:slug/...` ON `operatorAgents.ts`.
 * The delegated sign-in is not a property of an agent. One admin signs in
 * once for the whole directory and every agent provisioned afterwards — past,
 * present and future — uses that one token set. Hanging it off an agent slug
 * would have said the opposite in the URL: that each agent has its own
 * sign-in, which is exactly the per-agent manual step #924 exists to delete.
 * It would also have forced an arbitrary choice — WHICH agent's URL do you
 * sign in under? — and made "sign in before you create your first agent"
 * unrepresentable, even though that is the natural order of operations.
 *
 * So it mounts at `/api/v1/operator/teams`, a tenant-scoped sibling of
 * `/api/v1/operator/agents`, auth-gated by the same `requireAuth` at the
 * mount. The agent panel LINKS here; it does not host it.
 *
 * THE `flowHandle` NEVER LEAVES THE SERVER. `startDelegatedSignIn` returns a
 * handle that carries the OAuth `device_code` — during the flow's lifetime it
 * is as good as the credential it becomes. So:
 *
 *   * `POST /sign-in` answers with the user code, the verification URL, the
 *     expiry, the poll interval and the admin-consent URL. No handle.
 *   * `POST /sign-in/poll` takes NO body at all. The service polls the flow it
 *     is holding in memory.
 *
 * A browser therefore has nothing to leak into a URL bar, a screenshot, a
 * bug report or a proxy log, and there is no handle for this router to
 * validate, rate-limit or accidentally echo back in an error.
 *
 * NO SECRET IN ANY RESPONSE. Every payload below is built from
 * `DelegatedSignInPresence` (metadata only — see the token store) or from the
 * public start view. Nothing here can reach a token: this module never calls
 * `read()`. That is enforced by construction rather than by review, and pinned
 * by `teamsDelegatedRedaction.test.ts`.
 *
 * ERROR SHAPE follows the house style of `operatorAgents.ts`: `{ ok: true }`
 * on success, `{ error: '<machine_code>', message }` on failure, and the codes
 * are a closed vocabulary the UI localizes — never English prose it parses.
 */

import { Router, type Request, type Response } from 'express';

import {
  DelegatedSignInUnavailableError,
  type TeamsDelegatedSignInService,
} from '../services/teamsDelegatedSignInService.js';

/** Resolved late-bound, like every other operator dependency: the service
 *  registers only once the vault and the boot wiring exist. */
export interface OperatorTeamsSignInOptions {
  readonly getSignIn: () => TeamsDelegatedSignInService | undefined;
}

/** The 503 this router owns — the sign-in stack is not wired in this mount. */
const UNAVAILABLE = {
  error: 'teams_sign_in_unavailable',
  message:
    'The tenant Teams sign-in is not wired in this deployment — it registers once the secret vault and the agent-factory boot wiring are available.',
} as const;

export function createOperatorTeamsSignInRouter(
  options: OperatorTeamsSignInOptions,
): Router {
  const router = Router();

  /** Resolve the service or answer the 503. `undefined` = response sent. */
  function service(res: Response): TeamsDelegatedSignInService | undefined {
    const svc = options.getSignIn();
    if (!svc) {
      res.status(503).json(UNAVAILABLE);
      return undefined;
    }
    return svc;
  }

  /**
   * Turn a service failure into the house error shape.
   *
   * A typed {@link DelegatedSignInUnavailableError} carries its own machine
   * code and maps to 503 (the capability is missing) or 502 (Microsoft refused
   * the flow) — both are "not the operator's fault", and the distinction is
   * what tells "upgrade the connector" apart from "look at Conditional
   * Access". Anything else is a 500 with a generic code: an unclassified
   * failure must not become copy the UI pretends to understand.
   */
  function fail(res: Response, err: unknown): void {
    if (err instanceof DelegatedSignInUnavailableError) {
      const status = err.code === 'device_code_flow_failed' ? 502 : 503;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    console.warn('[operator-teams-signin] request failed:', err);
    res.status(500).json({
      error: 'teams_sign_in_failed',
      message: 'The Teams sign-in request could not be completed.',
    });
  }

  /**
   * Current sign-in state — who is signed in, until when, and whether a
   * device-code flow is waiting for someone to type the code.
   *
   * Also the page's ENTRY POINT after a reload: `pending` comes back
   * populated, so an operator who refreshed mid-flow gets their code back
   * instead of having to start over.
   */
  router.get('/sign-in', async (_req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    try {
      const status = await svc.status();
      res.json({ ok: true, ...status });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Begin a device-code sign-in. 202, because nothing has happened yet — a
   * human still has to go and type the code.
   */
  router.post('/sign-in', async (req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    try {
      // The only accepted input, and it is cosmetic: a label the connector may
      // show on the consent screen. Anything else in the body is ignored
      // rather than rejected — this endpoint takes no operational parameters.
      const raw = (req.body as { display_name?: unknown } | undefined)?.display_name;
      const displayName =
        typeof raw === 'string' && raw.trim().length > 0
          ? raw.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
          : undefined;
      const started = await svc.start(
        displayName !== undefined ? { displayName } : undefined,
      );
      res.status(202).json({ ok: true, pending: started });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Poll the flow. NO BODY — see the module header: the handle stays here.
   *
   * Always 200 with a `status` the UI switches on, including for `declined`
   * and `expired`: those are outcomes of a flow that worked, not transport
   * failures, and giving them a 4xx would make a fetch wrapper treat a
   * legitimate answer as an error.
   */
  router.post('/sign-in/poll', async (_req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    try {
      res.json({ ok: true, poll: await svc.poll() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Sign out. The local record is dropped even when the remote revoke fails —
   * see the service — and `remote` reports what Microsoft said, so nothing is
   * hidden behind a comfortable success.
   */
  router.delete('/sign-in', async (_req: Request, res: Response) => {
    const svc = service(res);
    if (!svc) return;
    try {
      const result = await svc.revoke();
      res.json({ ok: true, ...result, signIn: await svc.status() });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

/** A label on someone else's consent screen has no business being unbounded. */
const MAX_DISPLAY_NAME_LENGTH = 120;
