/**
 * Epic #470 C8b — machine-check the documented iframe trade.
 *
 * The same-origin plugin-UI decision in the plugin-UI plan §4.3a is an
 * accepted trade, not an accident. This file exists because a
 * documented trade with no test is just a comment: the day one premise changes,
 * the decision has to go red and force a re-read.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ServiceNotDeclaredError } from '@omadia/plugin-api';

import {
  classifyServiceGrant,
  createServiceGrantGate,
} from '../src/platform/pluginServiceGrants.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';

// The middleware is an ES module, so the CJS directory global does not
// exist here — derive the directory from import.meta.url instead.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const TOOL_PLUGIN_RUNTIME = path.resolve(
  HERE,
  '../src/plugins/toolPluginRuntime.ts',
);
const PUBLIC_PATH_GRANTS = path.resolve(
  HERE,
  '../src/platform/publicPathGrants.ts',
);
const AUTH_ROUTE = path.resolve(HERE, '../src/routes/auth.ts');

const DISTINCT_ORIGIN_REOPEN_MESSAGE =
  "plugin server code now appears isolated, so the same-origin plugin-UI decision recorded in the plugin-UI plan §4.3a rests on a premise that no longer holds — reopen it and move plugin UIs to a distinct origin. middleware/src/platform/pluginContext.ts already records that hardening path.";

function readSource(absPath: string): string {
  return readFileSync(absPath, 'utf-8');
}

function assertPinnedSnippet(opts: {
  source: string;
  exact: string;
  broad: RegExp;
  movedMessage: string;
  missingMessage: string;
}): void {
  if (opts.source.includes(opts.exact)) return;
  if (opts.broad.test(opts.source)) {
    assert.fail(opts.movedMessage);
  }
  assert.fail(opts.missingMessage);
}

describe('plugin UI trust model — tripwires for the C8b trade', () => {
  it('keeps plugin server code unsandboxed, which is the only reason §4.3a still tolerates a same-origin plugin UI', () => {
    const source = readSource(TOOL_PLUGIN_RUNTIME);

    assertPinnedSnippet({
      source,
      exact:
        'const mod = (await import(pathToFileURL(entryAbs).href)) as ToolPluginModuleShape;',
      broad: /import\(pathToFileURL\(entryAbs\)\.href\)/,
      movedMessage:
        "toolPluginRuntime.ts still dynamically imports the plugin entry, but the pinned `const mod = (await import(pathToFileURL(entryAbs).href)) ...` anchor moved — update this test's anchor instead of deleting the tripwire.",
      missingMessage:
        `${DISTINCT_ORIGIN_REOPEN_MESSAGE} The bare in-process dynamic import is no longer visible in middleware/src/plugins/toolPluginRuntime.ts.`,
    });

    const isolationImports =
      /\bfrom\s+['"](?:node:)?vm['"]|\bfrom\s+['"](?:node:)?worker_threads['"]|\bfrom\s+['"](?:node:)?child_process['"]|\brequire\((['"])(?:node:)?vm\1\)|\brequire\((['"])(?:node:)?worker_threads\2\)|\brequire\((['"])(?:node:)?child_process\3\)/;
    assert.ok(
      !isolationImports.test(source),
      DISTINCT_ORIGIN_REOPEN_MESSAGE,
    );
  });

  it("keeps `/api/v1/admin` core-reserved even though a same-origin frame can still ride the operator's cookie to it", () => {
    const source = readSource(PUBLIC_PATH_GRANTS);

    assertPinnedSnippet({
      source,
      exact: "  '/api/v1/admin',",
      broad: /['"]\/api\/v1\/admin['"]/,
      movedMessage:
        "publicPathGrants.ts still mentions `/api/v1/admin`, but the pinned CORE_RESERVED_ROOTS anchor moved — update the anchor rather than deleting the check. This test is where the §4.3a accepted exposure stays visible.",
      missingMessage:
        "`/api/v1/admin` is no longer core-reserved in middleware/src/platform/publicPathGrants.ts. Revisit the same-origin plugin-UI trade in the plugin-UI plan §4.3a before leaving the frame able to ride the operator cookie to that surface.",
    });
  });

  it('keeps the deny-by-default service-grant model real: undeclared services classify as undeclared and throw ServiceNotDeclaredError', () => {
    const agentId = '@omadia/example-ui';
    const catalog = {
      get(id: string) {
        if (id !== agentId) return undefined;
        return {
          plugin: {
            requires: ['knowledgeGraph@1'],
            provides: ['exampleUiRuntime@1'],
          },
        };
      },
    } as unknown as PluginCatalog;

    const declared = new Set<string>(['knowledgeGraph', 'exampleUiRuntime']);
    const outcome = classifyServiceGrant(agentId, 'graphPool', declared, catalog);
    assert.equal(
      outcome,
      'undeclared',
      'pluginServiceGrants.ts no longer classifies an undeclared service as `undeclared` — revisit the §4.3a trust-model rationale because the same-origin frame would no longer be bypassing a real server-side grant boundary.',
    );

    const assertServiceGranted = createServiceGrantGate({
      agentId,
      catalog,
      log: () => undefined,
    });
    assert.throws(
      () => assertServiceGranted('graphPool'),
      (error: unknown) => {
        assert.ok(
          error instanceof ServiceNotDeclaredError,
          'pluginServiceGrants.ts stopped throwing ServiceNotDeclaredError for an undeclared service — revisit the §4.3a trust-model rationale because the same-origin frame would no longer be bypassing a real deny-by-default gate.',
        );
        return true;
      },
      'pluginServiceGrants.ts no longer fail-closes undeclared services — revisit the same-origin plugin-UI trade in the plugin-UI plan §4.3a.',
    );
  });

  it("keeps the operator session a Path=/ admin session, which is what makes a same-origin fetch from the frame equivalent to the operator", () => {
    const source = readSource(AUTH_ROUTE);

    assertPinnedSnippet({
      source,
      exact: "      role: 'admin',",
      broad: /role:\s*'admin'/,
      movedMessage:
        "auth.ts still mints `role: 'admin'`, but the pinned anchor moved — update this test's anchor instead of deleting the tripwire.",
      missingMessage:
        "middleware/src/routes/auth.ts no longer mints the operator session with `role: 'admin'`. Revisit the same-origin plugin-UI decision in the plugin-UI plan §4.3a because the frame may no longer ride the full operator surface exactly as documented.",
    });

    assertPinnedSnippet({
      source,
      exact: "    path: '/',",
      broad: /path:\s*'\/'/,
      movedMessage:
        "auth.ts still sets the session cookie path to `/`, but the pinned anchor moved — update this test's anchor instead of deleting the tripwire.",
      missingMessage:
        "middleware/src/routes/auth.ts no longer sets the operator session cookie with `path: '/'`. Revisit the same-origin plugin-UI decision in the plugin-UI plan §4.3a because the frame may no longer ride the full operator surface exactly as documented.",
    });
  });
});
