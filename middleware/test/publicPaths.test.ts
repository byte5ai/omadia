import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publicPaths, STATIC_PUBLIC_PATHS } from '../src/auth/publicPaths.js';

/**
 * Regression guard for the MCP-OAuth-callback 401 bug: the epic #459 W9
 * callback (`/api/v1/operator/mcp-oauth/callback`) self-secures via a signed,
 * single-use `state` token — exactly like the spec-005 kernel OAuth broker
 * callback — but was never added to the requireAuth allowlist, so the
 * provider's post-consent redirect 401'd before ever reaching the handler
 * that validates that token. See publicPaths.ts's own module doc: tests here
 * must assert against the SAME array production runs.
 */
describe('publicPaths — MCP OAuth callback allowlist', () => {
  const allowlist = publicPaths({ devEndpointsEnabled: false });

  it('allows the generic MCP-server OAuth callback', () => {
    assert.equal(
      allowlist.some((p) => p.test('/api/v1/operator/mcp-oauth/callback?code=abc&state=xyz')),
      true,
    );
  });

  it('allows the bare callback path with no query string', () => {
    assert.equal(
      allowlist.some((p) => p.test('/api/v1/operator/mcp-oauth/callback')),
      true,
    );
  });

  it('does NOT widen the bypass to other /api/v1/operator routes', () => {
    assert.equal(
      allowlist.some((p) => p.test('/api/v1/operator/mcp-servers')),
      false,
    );
    assert.equal(
      allowlist.some((p) => p.test('/api/v1/operator/mcp-servers/abc123/discover')),
      false,
    );
  });

  it('does NOT match a path merely prefixed by the callback segment', () => {
    // Guards against an overly loose regex swallowing a sibling route.
    assert.equal(
      allowlist.some((p) => p.test('/api/v1/operator/mcp-oauth/callback-something-else')),
      false,
    );
  });

  it('is present in STATIC_PUBLIC_PATHS regardless of devEndpointsEnabled', () => {
    assert.equal(
      STATIC_PUBLIC_PATHS.some((p) => p.test('/api/v1/operator/mcp-oauth/callback')),
      true,
    );
  });
});
