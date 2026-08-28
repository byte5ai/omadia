/**
 * #778 W1 — composition-root wiring regression.
 *
 * The exact bug class this issue exists to close: `routes/credentialAsks.ts`
 * (#774) and `PgSkillOwnershipLifecycleStore.promoteSkillOwnerScope` (#577
 * P3) each shipped fully built and fully route/unit-tested — and stayed
 * unreachable for a whole phase because nobody added the one-line
 * `app.use(...)` in `src/index.ts`. A router's OWN test suite (e.g.
 * `credentialAskRoutes.test.ts`, which mounts the router into its own
 * throwaway `express()` app) passes identically whether or not `index.ts`
 * ever mounts it — that is the "passes every route test" trap the issue
 * names explicitly.
 *
 * `src/index.ts` runs `main().catch(...)` unconditionally at import time
 * (DB pools, mDNS, plugin catalog, `app.listen`), so it cannot be imported
 * or booted from a unit test without a full deployment's worth of config —
 * no test in this repo does that (verified: zero references to
 * `src/index.ts` from `test/**`). So this test drives the actual source
 * text of the composition root instead of executing it: it is the
 * deterministic half of "prove the mount," catching exactly the failure
 * mode of a route file existing, fully tested standalone, but never called
 * from `index.ts`. Reworded per the #470 ratchet's own guidance (never
 * touch a baseline it matches) — this file matches no ratchet pattern.
 *
 * The second half — that the mounted router actually behaves correctly at
 * runtime — is proven by `skillPromotionRoute.test.ts` (live `app.listen(0)`
 * + real `fetch`, this repo's established router-test pattern; see
 * `credentialAskRoutes.test.ts` and `adminProvidersRoute.test.ts`) and by
 * the pre-existing `credentialAskRoutes.test.ts` for the ask surface.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const middlewareRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(resolve(middlewareRoot, 'src', 'index.ts'), 'utf8');

/** Strip line comments so a mount reference sitting only in a `//` doc
 *  comment can never satisfy this check — it must be live code. */
function withoutLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const liveIndexSource = withoutLineComments(indexSource);
const conductorWebhookMountAnchor =
  "app.use(createConductorWebhooksInboundRouter(() => conductorWebhookInboundDepsRef));";
const globalJsonMountAnchor = "app.use(express.json({ limit: '10mb', verify: recordRawBodyBytes }));";

describe('#778 W1 — index.ts actually mounts the #577/#578 routers', () => {
  it('imports createSkillPromotionRouter from routes/skillPromotion.js', () => {
    assert.match(
      indexSource,
      /import\s*\{\s*createSkillPromotionRouter\s*\}\s*from\s*'\.\/routes\/skillPromotion\.js';/,
      'src/index.ts must import createSkillPromotionRouter — a route module that exists but is never imported can never be mounted',
    );
  });

  it('mounts the skill-promotion router at /api/v1/admin/skills behind requireAuth', () => {
    assert.match(
      liveIndexSource,
      /app\.use\(\s*'\/api\/v1\/admin\/skills',\s*requireAuth,\s*createSkillPromotionRouter\(/,
      "app.use('/api/v1/admin/skills', requireAuth, createSkillPromotionRouter(...)) must appear as LIVE code in index.ts, not only in a comment",
    );
  });

  it('imports createCredentialAskRouter from routes/credentialAsks.js', () => {
    assert.match(
      indexSource,
      /import\s*\{\s*createCredentialAskRouter\s*\}\s*from\s*'\.\/routes\/credentialAsks\.js';/,
      'src/index.ts must import createCredentialAskRouter — #774 built and route-tested this router but deliberately left it unmounted',
    );
  });

  it('mounts the credential-asks router at /api/v1/admin/credential-asks behind requireAuth', () => {
    assert.match(
      liveIndexSource,
      /app\.use\(\s*'\/api\/v1\/admin\/credential-asks',\s*requireAuth,\s*createCredentialAskRouter\(/,
      "app.use('/api/v1/admin/credential-asks', requireAuth, createCredentialAskRouter(...)) must appear as LIVE code in index.ts, not only in a comment",
    );
  });

  it('regression guard: fails if the skill-promotion mount line is commented out', () => {
    // Proves the "strip comments" step above actually does something —
    // without it, commenting out the app.use(...) line would still match
    // the raw-source regex and this whole test file would be a no-op.
    const withMountCommentedOut = indexSource.replace(
      /app\.use\(\s*'\/api\/v1\/admin\/skills',\s*requireAuth,\s*createSkillPromotionRouter\(/,
      (m) => `// ${m}`,
    );
    assert.notEqual(withMountCommentedOut, indexSource, 'the mount line must exist to be commented out by this check');
    const strippedIfCommented = withoutLineComments(withMountCommentedOut);
    assert.doesNotMatch(
      strippedIfCommented,
      /app\.use\(\s*'\/api\/v1\/admin\/skills',\s*requireAuth,\s*createSkillPromotionRouter\(/,
      'a commented-out mount must not satisfy the live-code check',
    );
  });
});

describe('#470 C10 — index.ts keeps the conductor webhook raw-body mount ahead of express.json', () => {
  it('mounts createConductorWebhooksInboundRouter before the global JSON parser', () => {
    const conductorMountIndex = liveIndexSource.indexOf(conductorWebhookMountAnchor);
    const globalJsonMountIndex = liveIndexSource.indexOf(globalJsonMountAnchor);

    assert.notEqual(
      conductorMountIndex,
      -1,
      `src/index.ts must contain the exact live-code anchor ${conductorWebhookMountAnchor}`,
    );
    assert.notEqual(
      globalJsonMountIndex,
      -1,
      `src/index.ts must contain the exact live-code anchor ${globalJsonMountAnchor}`,
    );
    assert.ok(
      conductorMountIndex < globalJsonMountIndex,
      'the conductor webhook router must stay mounted before the global express.json parser or route-level express.raw() will miss the raw body',
    );
  });
});
