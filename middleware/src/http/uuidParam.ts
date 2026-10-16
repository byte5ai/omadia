/**
 * `:id` guards for routes whose ids are Postgres `uuid` columns.
 *
 * Without a check, a malformed id reaches the query and Postgres rejects it
 * with `22P02 invalid input syntax for type uuid`. The route then answers 500
 * and, in some handlers, copies the Postgres message into the response
 * (#1318, #1398). An id that is not a UUID cannot name a row, so the honest
 * answer is the route's own 404 — the same one a well-formed but unknown id
 * gets.
 */

import type { NextFunction, Request, RequestParamHandler, Response } from 'express';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical (hyphenated, 36-char) UUID string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A `router.param(name, …)` handler that answers `404 { code, message }` for a
 * value that is not a UUID and passes everything else on. Registered per
 * router, it covers every route on that router naming the parameter, including
 * ones added later.
 */
export function requireUuidParam(code: string): RequestParamHandler {
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
    res.status(404).json({ code, message: `${name} '${String(value)}' not found` });
  };
}
