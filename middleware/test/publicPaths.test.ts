import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { publicPaths, STATIC_PUBLIC_PATHS } from '../src/auth/publicPaths.js';
import { CIMD_METADATA_PATH } from '../src/services/mcpCimd.js';

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

/**
 * W2-4 (issue #546) — the Client ID Metadata Document. An authorization server
 * fetches it with NO credential of ours; that is the entire mechanism (the
 * `client_id` we hand the AS is this URL, which it dereferences). So it must be
 * public, and it must be public via the SHARED constant: asserting against a
 * retyped literal here is precisely the drift this module's doc comment warns
 * about, so the test derives its expectation from `CIMD_METADATA_PATH` itself.
 */
describe('publicPaths — MCP client-ID metadata document allowlist', () => {
  const allowlist = publicPaths({ devEndpointsEnabled: false });

  it('allows the metadata document path built from the shared constant', () => {
    assert.equal(
      allowlist.some((p) => p.test(CIMD_METADATA_PATH)),
      true,
      `${CIMD_METADATA_PATH} must be public — an AS fetches it uncredentialed`,
    );
  });

  it('allows it with a query string appended', () => {
    assert.equal(
      allowlist.some((p) => p.test(`${CIMD_METADATA_PATH}?v=1`)),
      true,
    );
  });

  it('is present in STATIC_PUBLIC_PATHS regardless of devEndpointsEnabled', () => {
    assert.equal(
      STATIC_PUBLIC_PATHS.some((p) => p.test(CIMD_METADATA_PATH)),
      true,
    );
  });

  it('does NOT widen the bypass to a sibling well-known path', () => {
    assert.equal(
      allowlist.some((p) => p.test(`${CIMD_METADATA_PATH}-secret`)),
      false,
      'a prefix match would expose neighbouring well-known routes',
    );
    assert.equal(
      allowlist.some((p) => p.test('/.well-known/omadia-mcp-client/../../api/v1/operator/x')),
      false,
    );
  });
});
