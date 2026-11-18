/**
 * `:id` guards for routes whose ids are Postgres `uuid` columns.
 *
 * Without a check, a malformed id reaches the query and Postgres rejects it
 * with `22P02 invalid input syntax for type uuid`. The route then answers 500
 * and, in some handlers, copies the Postgres message into the response
 * (#1318, #1398, #1706). An id that is not a UUID cannot name a row, so the
 * honest answer is a refusal the route owns — a 404 like the one a well-formed
 * but unknown id gets, or a 400 where the caller is meant to tell "bad id"
 * apart from "no such row" (see `status` below).
 */

import type { NextFunction, Request, RequestParamHandler, Response } from 'express';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical (hyphenated, 36-char) UUID string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A `router.param(name, …)` handler that answers `{ code, message }` for a
 * value that is not a UUID and passes everything else on. Registered per
 * router, it covers every route on that router naming the parameter, including
 * ones added later.
 *
 * `status` picks which refusal the router prefers for a malformed id:
 *   - `404` (default) — "an id that cannot name a row is an unknown row",
 *     the reading `/admin/users` (#1318) and `/routines` (#1398) ship.
 *   - `400` — "the id itself is unusable", so a caller can tell a typo apart
 *     from a row that is gone. Conductor asks for this one (#1706), where the
 *     same handler also answers 404 for a well-formed id with no row behind it,
 *     and the two answers would otherwise be indistinguishable.
 */
export function requireUuidParam(code: string, status: 400 | 404 = 404): RequestParamHandler {
  return (
    _req: Request,
    res: Response,
    next: NextFunction,
    value: unknown,
    name: string,
  ): void => {
    if (typeof value === 'string' && isUuid(value)) {
      next();
      return;
    }
    const message =
      status === 400
        ? `${name} '${String(value)}' is not a valid id`
        : `${name} '${String(value)}' not found`;
    res.status(status).json({ code, message });
  };
}
