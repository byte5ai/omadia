import type { RequestHandler } from 'express';

import { PluginRouteRegistry } from '../../src/platform/pluginRouteRegistry.js';

/**
 * Epic #470 C6 — a `PluginRouteRegistry` for tests that are not about
 * authentication.
 *
 * `sessionAuth` is a REQUIRED constructor dependency in production code, on
 * purpose: an "unwired" registry would be a silent way for `auth: 'session'`
 * to mean nothing. Tests that genuinely do not care (route disposal, migration
 * wiring, service-registry ownership) still have to state a posture, and this
 * helper is where they state it — once, visibly, with a name that says what it
 * is rather than a bare `new PluginRouteRegistry()` that reads as "no auth
 * involved".
 *
 * Tests that ARE about authentication must NOT use this. They pass the real
 * `createRequireAuth(...)` — see `test/platform/pluginRouteAuthBody.test.ts`.
 */
export function newTestRouteRegistry(
  sessionAuth: RequestHandler = passThroughAuth,
): PluginRouteRegistry {
  return new PluginRouteRegistry({ sessionAuth: () => sessionAuth });
}

/** Explicitly named so a reader of a failing test can tell at a glance that
 *  this suite deliberately runs without a session gate. */
const passThroughAuth: RequestHandler = (_req, _res, next) => {
  next();
};
