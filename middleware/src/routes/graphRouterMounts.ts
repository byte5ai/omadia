/**
 * Issue #669 — the mount points for the knowledge-graph HTTP surfaces.
 *
 * These lived inline in `index.ts` inside ONE `if (config.DEV_ENDPOINTS_ENABLED)`
 * block, which conflated two different things:
 *
 *   - **Operator surfaces** — the KG-Lifecycle and per-agent-priorities admin
 *     routers, consumed by `/admin/kg-lifecycle` and `/admin/kg-priorities`.
 *     These are production operator tooling. Requiring a dev flag to reach them
 *     meant an operator who wanted the page had no supported way to get it
 *     without also publishing the dev scaffolding below.
 *   - **Dev scaffolding** — `createDevGraphRouter`, raw graph browsing for the
 *     Next.js dev UI.
 *
 * They are separated here, and the module exists (rather than staying inline)
 * for the reason `auth/publicPaths.ts` states in its own doc comment: a test
 * that assembles its own approximation of a mount proves nothing about the
 * mount production runs. Both the express wiring and the tests call these
 * functions and these path constants.
 *
 * Authentication for everything below is the OB-106 `app.use('/api', requireAuth, …)`
 * line, which runs for EVERY `/api/*` request whichever router answers it. The
 * explicit `requireAuth` argument each mount also passes is defence-in-depth
 * against a future reordering — it is the same middleware over the same
 * allowlist, so it is not an independent gate.
 */

import type { Express, RequestHandler } from 'express';

import type { AgentPrioritiesStore } from '@omadia/plugin-api';
import type { LifecycleService } from '@omadia/knowledge-graph-neon/dist/lifecycleService.js';
import type { KnowledgeGraph } from '@omadia/plugin-api';

import { createAgentPrioritiesRouter } from './agentPriorities.js';
import { createDevGraphLifecycleRouter } from './devGraphLifecycle.js';
import { createDevGraphRouter } from './devGraph.js';
import { createAdminDomainsRouter } from './adminDomains.js';
import { createLoopbackOnly } from '../auth/loopbackOnly.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';

/** Operator surface — authenticated, mounted regardless of any dev flag. */
export const KG_LIFECYCLE_ADMIN_PATH = '/api/v1/admin/kg-lifecycle';
/** Operator surface — authenticated, mounted regardless of any dev flag. */
export const KG_PRIORITIES_ADMIN_PATH = '/api/v1/admin/kg-priorities';
/** Operator surface — authenticated, mounted regardless of any dev flag. */
export const PLUGIN_DOMAINS_ADMIN_PATH = '/api/admin/domains';
/** Dev scaffolding — authenticated AND behind `DEV_ENDPOINTS_ENABLED`. */
export const DEV_GRAPH_PATH = '/api/dev/graph';

export interface KnowledgeGraphAdminDeps {
  /** Published as `graphLifecycle@1` by the Neon KG plugin only. */
  readonly lifecycle?: LifecycleService | undefined;
  /** Published as `agentPriorities@1` by the Neon KG plugin only. */
  readonly priorities?: AgentPrioritiesStore | undefined;
  /** Always present — the loaded-plugin catalog. */
  readonly catalog: PluginCatalog;
}

export interface KnowledgeGraphAdminMounted {
  readonly lifecycle: boolean;
  readonly priorities: boolean;
}

/**
 * Mount the operator-facing KG admin routers under the authenticated
 * `/api/v1/admin/*` prefix.
 *
 * Call this unconditionally. A router is skipped only when the service backing
 * it was never published — the in-memory KG backend publishes neither, because
 * the lifecycle sweeps are Postgres-specific. That absence is what the admin
 * page's empty state describes; it is no longer a feature-flag state.
 */
export function mountKnowledgeGraphAdmin(
  app: Express,
  requireAuth: RequestHandler,
  deps: KnowledgeGraphAdminDeps,
): KnowledgeGraphAdminMounted {
  const { lifecycle, priorities, catalog } = deps;

  if (lifecycle) {
    app.use(
      KG_LIFECYCLE_ADMIN_PATH,
      requireAuth,
      createDevGraphLifecycleRouter({ lifecycle }),
    );
  }
  if (priorities) {
    app.use(
      KG_PRIORITIES_ADMIN_PATH,
      requireAuth,
      createAgentPrioritiesRouter({ store: priorities }),
    );
  }
  // OB-77 — read-only plugin-domain listing. Its own comment always claimed it
  // was "mounted unconditionally"; the enclosing dev-flag `if` said otherwise.
  // Now the comment is true.
  app.use(PLUGIN_DOMAINS_ADMIN_PATH, requireAuth, createAdminDomainsRouter({ catalog }));

  return { lifecycle: Boolean(lifecycle), priorities: Boolean(priorities) };
}

export interface DevGraphMountDeps {
  readonly graph: KnowledgeGraph;
  /** `config.DEV_ENDPOINTS_ENABLED`. False ⇒ nothing is mounted. */
  readonly enabled: boolean;
  /** `config.DEV_ENDPOINTS_LOOPBACK_ONLY`. See `auth/loopbackOnly.ts`. */
  readonly loopbackOnly?: boolean;
  /** Injected by tests to silence the refusal log. */
  readonly log?: (message: string) => void;
}

/**
 * Mount the dev-only raw graph browser, when the flag says so.
 *
 * The flag is read HERE rather than in an `if` at the call site, deliberately:
 * it means `DEV_ENDPOINTS_ENABLED` is consumed in exactly one place that a
 * test can drive, and `mountKnowledgeGraphAdmin` above is incapable of
 * depending on it — its deps type has no field to carry it. That is the #669
 * separation expressed as a type rather than as a comment.
 *
 * `requireAuth` is passed explicitly so this mount reads as guarded at the call
 * site as well as behind the blanket `/api` line — the code comment that used
 * to say "unauthenticated, LOCAL USE ONLY" was, for a year, the only thing
 * standing between this router and the internet.
 */
export function mountDevGraph(
  app: Express,
  requireAuth: RequestHandler,
  deps: DevGraphMountDeps,
): boolean {
  if (!deps.enabled) return false;
  app.use(
    DEV_GRAPH_PATH,
    createLoopbackOnly({
      enabled: deps.loopbackOnly ?? false,
      ...(deps.log ? { log: deps.log } : {}),
    }),
    requireAuth,
    createDevGraphRouter({ graph: deps.graph }),
  );
  return true;
}
