import type { FileLinkRenewalService, FileLinkRenewer } from '@omadia/plugin-api';

/**
 * ADR-0266 (#1964) — the kernel's registry of signed-link renewers.
 *
 * Office and Diagrams register one renewer per route prefix (`/documents/dl`,
 * `/diagrams/dl`). `POST /api/v1/files/renew` (`routes/fileLinkRenew.ts`)
 * looks a link's path up here; an unknown prefix (plugin not installed or not
 * active) has no renewer.
 */

export interface ResolvedRenewer {
  readonly routePrefix: string;
  readonly renewer: FileLinkRenewer;
  /** The path after `<routePrefix>/`, still URL-encoded. */
  readonly encodedKey: string;
}

export interface FileLinkRenewalRegistry extends FileLinkRenewalService {
  /** The renewer whose prefix the pathname lies under, if any. */
  resolve(pathname: string): ResolvedRenewer | undefined;
}

/** A route prefix: absolute, at least one segment, no trailing slash. */
const ROUTE_PREFIX_PATTERN = /^(\/[A-Za-z0-9._-]+)+$/;

export function createFileLinkRenewalRegistry(): FileLinkRenewalRegistry {
  const renewers = new Map<string, FileLinkRenewer>();

  return {
    registerRenewer(routePrefix: string, renewer: FileLinkRenewer): () => void {
      if (!ROUTE_PREFIX_PATTERN.test(routePrefix)) {
        throw new Error(`fileLinkRenewal: invalid route prefix '${routePrefix}'`);
      }
      if (renewers.has(routePrefix)) {
        throw new Error(`fileLinkRenewal: a renewer for '${routePrefix}' is already registered`);
      }
      renewers.set(routePrefix, renewer);
      return () => {
        if (renewers.get(routePrefix) === renewer) renewers.delete(routePrefix);
      };
    },

    resolve(pathname: string): ResolvedRenewer | undefined {
      for (const [routePrefix, renewer] of renewers) {
        const head = `${routePrefix}/`;
        if (pathname.startsWith(head) && pathname.length > head.length) {
          return { routePrefix, renewer, encodedKey: pathname.slice(head.length) };
        }
      }
      return undefined;
    },
  };
}
