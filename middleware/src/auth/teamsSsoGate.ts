import type { RequestHandler } from 'express';

import type { TeamsSsoUser } from '@omadia/plugin-api';

import { bearerToken, TeamsSsoError } from './teamsSsoVerifier.js';
import type { TeamsSsoVerifier } from './teamsSsoVerifier.js';

/**
 * `auth: 'teams-sso'` exposes the verified Teams user here (#1620).
 *
 * Set by {@link createTeamsSsoGate} and by nothing else; present on every
 * request a `'teams-sso'` route's handler sees, absent everywhere else.
 */
declare module 'express-serve-static-core' {
  interface Request {
    teamsSsoUser?: TeamsSsoUser;
  }
}

const UNAUTHORIZED_BODY = {
  code: 'auth.teams_sso_required',
  message: 'Microsoft Teams sign-in required',
} as const;

export interface TeamsSsoGateOptions {
  readonly verifier: TeamsSsoVerifier;
  /** Server-side diagnostics for a refusal: the reason and the route source.
   *  Never the token. Defaults to `console.warn`. */
  readonly onRefuse?: (reason: string, source: string) => void;
}

/**
 * The per-route gate for `auth: 'teams-sso'` (#1620).
 *
 * PURE Teams SSO: the gate reads `Authorization: Bearer` and nothing else. An
 * omadia session cookie neither opens a `'teams-sso'` route nor is consulted,
 * so the route has exactly one way in, and its handler always knows which
 * Teams user it is serving. (A route that also wants operator access registers
 * a second, `'session'` router on its own prefix — Builder codegen does that.)
 *
 * Every refusal is the same 401 with the same body. Why a token failed —
 * expired, wrong tenant, bad signature, key discovery down — goes to the server
 * log, never to the caller: those answers are a free oracle for someone
 * crafting tokens. A verifier crash is a refusal too, never a pass.
 *
 * Any `teamsSsoUser` a caller managed to put on the request before this gate
 * runs is deleted first, so a handler can only ever see the gate's own value.
 */
export function createTeamsSsoGate(
  source: string,
  opts: TeamsSsoGateOptions,
): RequestHandler {
  const refuseLog =
    opts.onRefuse ??
    ((reason: string, from: string) =>
      console.warn(`[teams-sso] refused a request for '${from}': ${reason}`));

  return (req, res, next) => {
    delete req.teamsSsoUser;
    // The answer depends on the bearer, so no cache may reuse it across users.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');

    const refuse = (reason: string): void => {
      refuseLog(reason, source);
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json(UNAUTHORIZED_BODY);
    };

    const token = bearerToken(req.headers.authorization);
    if (!token) {
      // Not logged: that is every anonymous scan, and it says nothing.
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }
    opts.verifier.verify(token).then(
      (principal) => {
        req.teamsSsoUser = {
          oid: principal.objectId,
          tenantId: principal.tenantId,
          appId: principal.appId,
          ...(principal.upn ? { upn: principal.upn } : {}),
        };
        next();
      },
      (err: unknown) => {
        refuse(
          err instanceof TeamsSsoError
            ? err.message
            : `verifier error: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  };
}
