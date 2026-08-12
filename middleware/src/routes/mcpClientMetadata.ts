/**
 * The Client ID Metadata Document endpoint (W2-4, issue #546).
 *
 * `GET /.well-known/omadia-mcp-client` serves the JSON an authorization server
 * dereferences when omadia hands it a CIMD `client_id`. Public by design and by
 * necessity: an IdP fetches it with no credential of ours, exactly like
 * `/.well-known/oauth-protected-resource` on the other side of the protocol.
 * It contains no secret — only the redirect URI and a display name, both of
 * which the IdP already sees during the authorize round-trip.
 *
 * ── Degraded path, not a hard failure ───────────────────────────────────────
 * When no inbound-reachable public base origin is configured, this route answers
 * **501 Not Implemented** with an actionable message instead of serving a
 * document with a wrong or unreachable `client_id`. That is deliberate: CIMD
 * requires the IdP to reach IN to omadia, which is strictly stronger than the
 * outbound-redirect-only requirement every other mode has, and impossible on a
 * firewalled or air-gapped install. Those installs keep working through the
 * manual client path — a 501 here breaks nothing.
 */

import { Router, type Request, type Response } from 'express';

import { CIMD_METADATA_PATH, buildCimdDocument } from '../services/mcpCimd.js';

export interface McpClientMetadataOptions {
  /**
   * The stable metadata-document URL (which IS the `client_id`), or null when
   * `FLOW_PUBLIC_BASE_URL` is unset. Derived from CONFIG, never from the inbound
   * `Host` header — a per-request host would mint a different client_id per
   * proxy hop and invalidate every stored `mcp_oauth_clients` row.
   */
  readonly metadataUrl: string | null;
  /**
   * MUST be `McpOAuthService.redirectUri` verbatim. The AS matches the authorize
   * request's `redirect_uri` against the `redirect_uris` served here; a mismatch
   * fails every code exchange, at the provider, far from the cause. Wired from
   * the same variable in index.ts and asserted in mcpOAuth.test.ts.
   */
  readonly redirectUri: string | null;
  readonly clientName?: string;
}

/** Path this router serves, re-exported so callers need not import two modules. */
export { CIMD_METADATA_PATH };

export function createMcpClientMetadataRouter(options: McpClientMetadataOptions): Router {
  const router = Router();

  router.get(CIMD_METADATA_PATH, (_req: Request, res: Response) => {
    const { metadataUrl, redirectUri } = options;
    if (!metadataUrl || !redirectUri) {
      res.status(501).json({
        error: 'cimd_unavailable',
        message:
          'Client ID Metadata Documents are not available on this install: no inbound-reachable public base URL is configured. Set FLOW_PUBLIC_BASE_URL to an https origin this deployment is reachable at FROM THE INTERNET (the identity provider must fetch this document). If inbound access is not possible — the normal case behind a corporate firewall — nothing is broken: register a one-time OAuth client per issuer in the MCP Control Center instead. That manual path is fully supported and is the correct path for Microsoft Entra ID and Okta, neither of which supports CIMD.',
      });
      return;
    }
    // Cacheable but short: an IdP may fetch this on every authorize, and the
    // document only changes when the operator changes the deployment's base URL.
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(
      buildCimdDocument({
        metadataUrl,
        redirectUri,
        ...(options.clientName ? { clientName: options.clientName } : {}),
      }),
    );
  });

  return router;
}
