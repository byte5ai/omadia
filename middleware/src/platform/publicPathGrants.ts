import { z } from 'zod';

/**
 * Epic #470 C4 / H1 — manifest-declared, operator-consented public-path grants
 * with exclusive prefix ownership.
 *
 * WHY THIS IS NOT A DYNAMIC `publicPaths`
 * ---------------------------------------
 * The obvious design is "let a plugin push an entry into `auth/publicPaths.ts`".
 * It rebuilds the exact hole it is meant to close. `requireAuth` runs *before*
 * routing: it sees a URL and nothing else, so it structurally cannot know which
 * router will finally answer. An entry there says "this URL needs no session"
 * — it does not say "and only plugin A may answer it". Plugin A gets a grant
 * for a prefix, does not handle some subpath under it, and plugin B (or a core
 * router, or a future mount) answers that subpath with no session at all.
 *
 * So `auth/publicPaths.ts` stays a frozen, core-owned literal, and the grant
 * lives in a mount slot placed *before* `requireAuth` which **terminates**:
 * a request under a granted prefix is dispatched to the owning plugin's router
 * and, if that router does not handle it, answered 404 — never passed on into
 * the authenticated stack. See `publicPathMount.ts`.
 *
 * That ordering is what makes the whole mechanism fail-closed. If the grant
 * table is empty, the store is down, the plugin never activated, or this
 * registry is not wired at all, nothing matches, the early mount calls
 * `next()`, and `requireAuth` 401s exactly as it does today. Every failure mode
 * degrades to "more authentication", never to "less".
 *
 * THREE INDEPENDENT GATES
 * -----------------------
 *   1. **Declaration** — the plugin lists the prefix in its manifest under
 *      `permissions.public_paths`. Syntactically validated here.
 *   2. **Ownership** — the prefix is claimed exclusively at activation time.
 *      First activation wins; a second plugin declaring an overlapping prefix
 *      fails to activate with a named-conflict error.
 *   3. **Consent** — the operator has a row in `plugin_public_path_grants` for
 *      that exact prefix. Declared-but-not-granted prefixes are claimed (so
 *      nobody else can take them) but never mounted publicly.
 *
 * All three must hold. Any one missing and the request goes to `requireAuth`.
 */

/**
 * The reserved root for plugin-declared public paths. A third-party plugin
 * should always namespace under `/api/plugins/<its-own-id>/…`: it is the one
 * shape that cannot collide with a core route, present or future.
 *
 * A plugin may additionally declare a public path under a prefix it actually
 * registers a router at (see `claim()`), which is what lets a plugin that owns
 * a historical, frozen wire path keep serving it after core stops exempting it
 * statically. That check runs against the LIVE route registry, not against a
 * hardcoded list, so no core file has to name any particular plugin's paths.
 */
export const PLUGIN_PUBLIC_PATH_ROOT = '/api/plugins/';

/**
 * Roots core owns unconditionally. Not a duplicate of `publicPaths()` — that
 * list is about which URLs skip the session gate, this one is about which URLs
 * a plugin may never *claim*, granted or not. `/api/v1/admin` is not in
 * `publicPaths()` (it is firmly behind the gate) and precisely for that reason
 * it must never become claimable: an operator clicking through a consent
 * dialog should not be able to hand a plugin the admin surface.
 */
const CORE_RESERVED_ROOTS: readonly string[] = [
  '/api/auth',
  '/api/chat',
  '/api/hooks',
  '/api/messages',
  '/api/public',
  '/api/v1/admin',
  '/api/v1/auth',
  '/api/v1/install',
  '/api/v1/memory',
  '/api/v1/operator',
  '/api/v1/setup',
];

/** Hard cap so a pathological manifest cannot blow up the per-request match. */
export const MAX_DECLARED_PUBLIC_PATHS = 16;
const MAX_PATH_LENGTH = 256;

/**
 * Syntactic shape of one `permissions.public_paths` entry.
 *
 * Deliberately strict and deliberately zod: this string ends up deciding
 * whether a URL skips authentication, so every character it may contain is
 * enumerated rather than filtered. No wildcards (the match is prefix-based
 * already), no percent-encoding (`%2e%2e` is `..` after Express decodes it),
 * no query or fragment (the match runs against `req.path`, which has neither),
 * no dot segments.
 */
export const publicPathEntrySchema = z
  .string()
  .min(2)
  .max(MAX_PATH_LENGTH)
  .regex(
    /^(?:\/[A-Za-z0-9._~-]+)+$/,
    'must be a slash-separated path of unreserved characters (no wildcards, no query, no percent-encoding)',
  )
  .refine(
    (p) => !p.split('/').some((seg) => seg === '.' || seg === '..'),
    'must not contain "." or ".." segments',
  )
  .refine(
    (p) => p.split('/').filter((s) => s.length > 0).length >= 2,
    'must be at least two segments deep — a one-segment claim is too broad',
  );

/** `permissions.public_paths` as a whole. */
export const publicPathsDeclarationSchema = z
  .array(publicPathEntrySchema)
  .max(MAX_DECLARED_PUBLIC_PATHS);

/** True when `child` is `parent` itself or lies beneath it on a segment boundary. */
export function isUnderPrefix(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSlash = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(withSlash);
}

/** Two prefixes overlap when either one contains the other. */
function prefixesOverlap(a: string, b: string): boolean {
  return isUnderPrefix(a, b) || isUnderPrefix(b, a);
}

export interface PublicPathValidationContext {
  /** The core exemption list, passed in rather than imported so tests assert
   *  against the same array production runs (same reason `publicPaths.ts`
   *  exists as its own module). */
  readonly corePublicPaths: readonly RegExp[];
  /** Prefixes this plugin actually registered a router at. A plugin may only
   *  make public something it genuinely serves. */
  readonly ownRoutePrefixes: readonly string[];
}

export type PublicPathValidation =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * Validate ONE declared path against everything that does not require knowing
 * about other plugins. Cross-plugin exclusivity is `claim()`'s job.
 */
export function validateDeclaredPublicPath(
  raw: unknown,
  ctx: PublicPathValidationContext,
): PublicPathValidation {
  const parsed = publicPathEntrySchema.safeParse(raw);
  if (!parsed.success) {
    const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return {
      ok: false,
      path: String(shown),
      reason:
        parsed.error.issues[0]?.message ??
        'is not a valid public-path declaration',
    };
  }
  const p = parsed.data;

  const reserved = CORE_RESERVED_ROOTS.find((root) => prefixesOverlap(p, root));
  if (reserved) {
    return {
      ok: false,
      path: p,
      reason: `overlaps the core-reserved root '${reserved}' — core routes are never grantable`,
    };
  }

  // Already a core exemption? Then the grant is redundant AND ambiguous: two
  // mechanisms would claim to own the same URL and only one of them terminates.
  // Reject loudly rather than silently letting the static entry win. Once core
  // drops a static exemption, the same declaration starts validating — which is
  // exactly the handover this mechanism exists to make possible.
  const probe = `${p}/`;
  const collidingCoreEntry = ctx.corePublicPaths.find(
    (re) => re.test(p) || re.test(probe),
  );
  if (collidingCoreEntry) {
    return {
      ok: false,
      path: p,
      reason: `is already a static core public path (${String(collidingCoreEntry)}) — remove the core exemption first, or drop the declaration`,
    };
  }

  const underReservedRoot = isUnderPrefix(p, PLUGIN_PUBLIC_PATH_ROOT);
  const underOwnRoute = ctx.ownRoutePrefixes.some((prefix) =>
    isUnderPrefix(p, prefix),
  );
  if (!underReservedRoot && !underOwnRoute) {
    return {
      ok: false,
      path: p,
      reason:
        ctx.ownRoutePrefixes.length === 0
          ? `must start with '${PLUGIN_PUBLIC_PATH_ROOT}' — the plugin registered no routers, so it owns no other prefix`
          : `must start with '${PLUGIN_PUBLIC_PATH_ROOT}' or lie under a prefix this plugin registers (${ctx.ownRoutePrefixes.join(', ')})`,
    };
  }

  return { ok: true, path: p };
}

/** Thrown by `claim()`. Carries the conflicting plugin so the operator-facing
 *  error names both sides rather than saying "conflict". */
export class PublicPathClaimError extends Error {
  constructor(
    readonly pluginId: string,
    readonly path: string,
    reason: string,
    readonly conflictsWith?: string,
  ) {
    super(
      `public-path declaration '${path}' from plugin '${pluginId}' ${reason}`,
    );
    this.name = 'PublicPathClaimError';
  }
}

export interface PublicPathClaim {
  readonly pluginId: string;
  readonly prefix: string;
  /** Whether the operator has consented to this prefix. Claimed-but-ungranted
   *  prefixes hold the ownership reservation and serve nothing. */
  readonly granted: boolean;
}

export interface PublicPathMatch {
  readonly pluginId: string;
  readonly prefix: string;
}

/**
 * Who owns which public prefix, and which of those the operator consented to.
 *
 * In-memory and authoritative for routing. Durable operator consent lives in
 * `plugin_public_path_grants` (see `publicPathGrantStore.ts`); this registry is
 * told about it at activation and whenever consent changes.
 */
export class PublicPathGrantRegistry {
  /** prefix → owner. One map, so exclusivity is a `Map` invariant, not a scan. */
  private readonly byPrefix = new Map<
    string,
    { pluginId: string; granted: boolean }
  >();

  /**
   * Claim every declared prefix for `pluginId`, exclusively.
   *
   * Re-claiming is idempotent for the SAME plugin (hot-reactivate releases its
   * own prior claims first), and hard-fails for a different one: first
   * activation wins and the second gets a named error. Nothing partial is left
   * behind — a rejection rolls back the prefixes this call already took, so a
   * failed activation cannot squat on a prefix nobody can then reclaim.
   *
   * @param grantedPrefixes prefixes the operator has already consented to.
   *        Anything outside this set is claimed but not served.
   */
  claim(
    pluginId: string,
    declaredPaths: readonly unknown[],
    ctx: PublicPathValidationContext & {
      readonly grantedPrefixes: ReadonlySet<string>;
    },
  ): void {
    if (declaredPaths.length > MAX_DECLARED_PUBLIC_PATHS) {
      throw new PublicPathClaimError(
        pluginId,
        `${String(declaredPaths.length)} entries`,
        `exceeds the maximum of ${String(MAX_DECLARED_PUBLIC_PATHS)} declared public paths`,
      );
    }
    // Hot-reactivate: drop this plugin's own reservations so re-declaring the
    // same prefix is not a self-conflict.
    this.releaseBySource(pluginId);

    const taken: string[] = [];
    try {
      for (const raw of declaredPaths) {
        const check = validateDeclaredPublicPath(raw, ctx);
        if (!check.ok) {
          throw new PublicPathClaimError(pluginId, check.path, check.reason);
        }
        const prefix = check.path;
        for (const [existing, owner] of this.byPrefix) {
          if (prefixesOverlap(prefix, existing)) {
            throw new PublicPathClaimError(
              pluginId,
              prefix,
              `overlaps '${existing}', already owned by plugin '${owner.pluginId}'`,
              owner.pluginId,
            );
          }
        }
        this.byPrefix.set(prefix, {
          pluginId,
          granted: ctx.grantedPrefixes.has(prefix),
        });
        taken.push(prefix);
      }
    } catch (err) {
      for (const prefix of taken) this.byPrefix.delete(prefix);
      throw err;
    }
  }

  /**
   * Re-apply operator consent for an already-activated plugin, so granting or
   * revoking in the admin UI takes effect without a restart. Prefixes the
   * plugin never declared are ignored — consent cannot invent ownership.
   */
  setGranted(pluginId: string, grantedPrefixes: ReadonlySet<string>): void {
    for (const [prefix, owner] of this.byPrefix) {
      if (owner.pluginId !== pluginId) continue;
      owner.granted = grantedPrefixes.has(prefix);
    }
  }

  /**
   * The owning plugin for a request path, or `null` when the path is not
   * publicly granted. Only GRANTED prefixes match: a declared-but-unconsented
   * prefix resolves to `null` and the request goes to `requireAuth`.
   *
   * Longest prefix wins. Overlapping claims are rejected at claim time, so this
   * is belt-and-braces rather than load-bearing — but if the invariant is ever
   * broken, the more specific claim answering is the safer of the two outcomes.
   */
  resolve(requestPath: string): PublicPathMatch | null {
    let best: PublicPathMatch | null = null;
    for (const [prefix, owner] of this.byPrefix) {
      if (!owner.granted) continue;
      if (!isUnderPrefix(requestPath, prefix)) continue;
      if (best === null || prefix.length > best.prefix.length) {
        best = { pluginId: owner.pluginId, prefix };
      }
    }
    return best;
  }

  /** Drop every claim held by `pluginId`. Returns how many were released. */
  releaseBySource(pluginId: string): number {
    let count = 0;
    for (const [prefix, owner] of [...this.byPrefix]) {
      if (owner.pluginId !== pluginId) continue;
      this.byPrefix.delete(prefix);
      count += 1;
    }
    return count;
  }

  /** Diagnostic + admin surface: who owns what, and what is consented. */
  list(): readonly PublicPathClaim[] {
    return [...this.byPrefix].map(([prefix, owner]) => ({
      pluginId: owner.pluginId,
      prefix,
      granted: owner.granted,
    }));
  }
}
