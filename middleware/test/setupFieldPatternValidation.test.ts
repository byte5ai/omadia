import { describe, it, after, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createRuntimeRouter } from '../src/routes/runtime.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { extractSetupSchema } from '../src/plugins/installService.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import {
  anchorPatternSource,
  checkSetupFieldPattern,
  compileSetupPattern,
  getPatternProblems,
  matchWithBudget,
  resetSetupPatternCache,
  screenPatternSource,
  shutdownPatternWorker,
  warmPatternWorker,
  MAX_PATTERN_INPUT_LENGTH,
} from '../src/plugins/setupFieldPattern.js';

/**
 * OM-17 — server-side validation of setup-field VALUES.
 *
 * A customer installed the Google Workspace plugin, saw an email field with a
 * masked field beneath it, and entered their work email and their real Google
 * account password. Both were accepted and confirmed as "gespeichert". The
 * fields wanted `gw_sa_client_email` / `gw_sa_private_key` out of a
 * service-account JSON key.
 *
 * The load-bearing half of the fix is server-side: the vault write happens on
 * the server, so a client-side check alone is theatre. These tests pin that
 * half — including the backward-compatibility guarantee that a field WITHOUT a
 * declared pattern still accepts anything, exactly as before.
 */

const PLUGIN_ID = 'de.byte5.agent.test';

/** The two real Google service-account shapes, as a plugin would declare them. */
const SA_EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$';
const PEM_PATTERN = '^-----BEGIN PRIVATE KEY-----';

interface SetupFieldSpec {
  key: string;
  type: string;
  label?: string;
  pattern?: string;
  pattern_hint?: Record<string, string> | string;
}

interface Harness {
  baseUrl: string;
  vault: InMemorySecretVault;
  close(): Promise<void>;
}

async function makeHarness(fields: SetupFieldSpec[]): Promise<Harness> {
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: PLUGIN_ID,
    installed_version: '0.1.0',
    installed_at: new Date().toISOString(),
    status: 'active',
    config: {},
  });

  const stubEntry: PluginCatalogEntry = {
    plugin: { id: PLUGIN_ID, name: 'Test Agent', version: '0.1.0' } as never,
    manifest: { setup: { fields } },
    source_path: '<test>',
    source_kind: 'manifest-v1',
  };
  const catalog = {
    get: (id: string): PluginCatalogEntry | undefined =>
      id === PLUGIN_ID ? stubEntry : undefined,
  } as unknown as PluginCatalog;

  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      serviceRegistry: stubReg as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      vault,
      catalog,
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function patchSecrets(
  h: Harness,
  set: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${h.baseUrl}/api/v1/admin/runtime/installed/${PLUGIN_ID}/secrets`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ set }),
    },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('OM-17 — PATCH /installed/:id/secrets validates against the declared pattern', () => {
  let h: Harness | undefined;
  beforeEach(() => {
    resetSetupPatternCache();
  });
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('accepts a value that matches the pattern', async () => {
    h = await makeHarness([
      { key: 'gw_sa_client_email', type: 'string', pattern: SA_EMAIL_PATTERN },
    ]);
    const { status } = await patchSecrets(h, {
      gw_sa_client_email: 'omadia@my-project.iam.gserviceaccount.com',
    });
    assert.equal(status, 200);
  });

  it('rejects a violating value with 400 runtime.setup_field_invalid + field + hint', async () => {
    // The literal failure from the bug report: a human work address typed into
    // the service-account email field.
    h = await makeHarness([
      {
        key: 'gw_sa_client_email',
        type: 'string',
        pattern: SA_EMAIL_PATTERN,
        pattern_hint: { en: 'expects …@….iam.gserviceaccount.com' },
      },
    ]);
    const { status, body } = await patchSecrets(h, {
      gw_sa_client_email: 'tester@customer-company.de',
    });
    assert.equal(status, 400);
    assert.equal(body['code'], 'runtime.setup_field_invalid');
    assert.equal(body['field'], 'gw_sa_client_email');
    assert.equal(body['hint'], 'expects …@….iam.gserviceaccount.com');
  });

  it('writes NOTHING when one field in the patch is invalid', async () => {
    // Fail-closed: a partial write would leave the plugin half-configured,
    // which the readiness computation would then report as configured.
    h = await makeHarness([
      { key: 'ok_field', type: 'secret' },
      { key: 'gw_sa_private_key', type: 'secret', pattern: PEM_PATTERN },
    ]);
    const { status } = await patchSecrets(h, {
      ok_field: 'fine',
      // What the tester actually typed: an account password.
      gw_sa_private_key: 'hunter2',
    });
    assert.equal(status, 400);
    assert.deepEqual(await h.vault.listKeys(PLUGIN_ID), []);
  });

  it('BACKWARD COMPAT: a field with no pattern accepts anything, as before', async () => {
    h = await makeHarness([{ key: 'legacy_secret', type: 'secret' }]);
    const { status } = await patchSecrets(h, {
      legacy_secret: 'literally anything at all !@#$%',
    });
    assert.equal(status, 200);
    assert.deepEqual(await h.vault.listKeys(PLUGIN_ID), ['legacy_secret']);
  });

  it('a key that matches no declared field is still accepted', async () => {
    h = await makeHarness([
      { key: 'gw_sa_client_email', type: 'string', pattern: SA_EMAIL_PATTERN },
    ]);
    const { status } = await patchSecrets(h, { undeclared_key: 'whatever' });
    assert.equal(status, 200);
  });

  it('an uncompilable pattern is dropped at load and does NOT 500', async () => {
    h = await makeHarness([
      { key: 'broken', type: 'secret', pattern: '([unclosed' },
    ]);
    const { status } = await patchSecrets(h, { broken: 'anything' });
    assert.equal(status, 200);
  });

  it('a catastrophically-backtracking pattern is dropped, not run', async () => {
    h = await makeHarness([
      { key: 'redos', type: 'secret', pattern: '^(a+)+$' },
    ]);
    const started = Date.now();
    const { status } = await patchSecrets(h, {
      redos: `${'a'.repeat(2000)}b`,
    });
    assert.equal(status, 200);
    // If the nested-quantifier screen ever regresses, this would not return.
    assert.ok(Date.now() - started < 5000);
  });
});

describe('OM-17 — compileSetupPattern safety screen', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  it('compiles a sane pattern', () => {
    assert.ok(compileSetupPattern(SA_EMAIL_PATTERN, 'test') instanceof RegExp);
  });

  it('drops an invalid regex', () => {
    assert.equal(compileSetupPattern('([unclosed', 'test'), null);
  });

  it('drops a nested quantifier', () => {
    assert.equal(compileSetupPattern('^(a+)+$', 'test'), null);
    assert.equal(compileSetupPattern('([a-z]+)*', 'test'), null);
  });

  it('drops an over-long pattern source', () => {
    assert.equal(compileSetupPattern('a'.repeat(600), 'test'), null);
  });

  it('rejects an over-long INPUT without running the regex', async () => {
    const violation = await checkSetupFieldPattern(
      { key: 'k', pattern: '^.*$' },
      'x'.repeat(MAX_PATTERN_INPUT_LENGTH + 1),
    );
    // `^.*$` would otherwise match — the length cap wins, deliberately.
    assert.equal(violation?.field, 'k');
  });

  it('`hint` is the ENGLISH entry, and that is the documented contract', async () => {
    // The middleware has no request locale — nothing reads Accept-Language and
    // `NEXT_LOCALE` never leaves the Next.js layer — so it must not pretend to
    // pick one. English is the fallback for API clients with no manifest; a
    // client that HOLDS the manifest resolves `pattern_hint` itself, keyed on
    // `violation.field`. Pinned so nobody "fixes" this into a guessed locale.
    const violation = await checkSetupFieldPattern(
      {
        key: 'gw_sa_client_email',
        pattern: SA_EMAIL_PATTERN,
        pattern_hint: {
          en: 'expects …@….iam.gserviceaccount.com',
          de: 'erwartet …@….iam.gserviceaccount.com',
        },
      },
      'tester@customer-company.de',
    );
    assert.equal(violation?.field, 'gw_sa_client_email');
    assert.equal(violation?.hint, 'expects …@….iam.gserviceaccount.com');
  });

  it('omits `hint` when the manifest declared no pattern_hint', async () => {
    // The API must never invent user-facing prose; the web-ui owns that copy.
    const violation = await checkSetupFieldPattern(
      { key: 'k', pattern: '^abc$' },
      'nope',
    );
    assert.equal(violation?.field, 'k');
    assert.equal(violation?.hint, undefined);
  });
});

describe('OM-17 — manifestLoader parses pattern_hint and screens pattern', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  function load(field: Record<string, unknown>) {
    return adaptManifestV1({
      schema_version: '1',
      identity: { id: 'test-plugin', name: 'Test', version: '1.0.0' },
      setup: { fields: [field] },
    });
  }

  it('parses a localized pattern_hint', () => {
    const plugin = load({
      key: 'gw_sa_client_email',
      type: 'string',
      label: 'Service account email',
      pattern: SA_EMAIL_PATTERN,
      pattern_hint: {
        en: 'expects …@….iam.gserviceaccount.com',
        de: 'erwartet …@….iam.gserviceaccount.com',
      },
    });
    const f = plugin?.setup_fields[0];
    assert.equal(f?.pattern, SA_EMAIL_PATTERN);
    assert.equal(f?.pattern_hint?.['en'], 'expects …@….iam.gserviceaccount.com');
    assert.equal(f?.pattern_hint?.['de'], 'erwartet …@….iam.gserviceaccount.com');
  });

  it('tolerates a bare-string pattern_hint as English', () => {
    const plugin = load({
      key: 'k',
      type: 'secret',
      pattern: PEM_PATTERN,
      pattern_hint: 'expects a PEM block',
    });
    assert.equal(plugin?.setup_fields[0]?.pattern_hint?.['en'], 'expects a PEM block');
  });

  it('drops an invalid regex — the field survives, the pattern does not', () => {
    const plugin = load({
      key: 'k',
      type: 'secret',
      pattern: '([unclosed',
      pattern_hint: { en: 'never rendered' },
    });
    const f = plugin?.setup_fields[0];
    assert.equal(f?.key, 'k');
    assert.equal(f?.pattern, undefined);
    assert.equal(f?.pattern_hint, undefined);
  });

  it('drops a nested-quantifier pattern', () => {
    const plugin = load({ key: 'k', type: 'secret', pattern: '^(a+)+$' });
    assert.equal(plugin?.setup_fields[0]?.pattern, undefined);
  });
});

// ---------------------------------------------------------------------------
// F1 — the blacklist screen was BYPASSABLE; it is now an allowlist grammar
// ---------------------------------------------------------------------------

/**
 * Every row here was executed against the OLD blacklist screen
 * (`/\((?![?][:=!<])[^()]*[+*}][^()]*\)\s*[+*{]/`) and PASSED it, then burned
 * hundreds of milliseconds to seconds on a ~26-character subject. Alternation
 * blowups contain no nested quantifier at all, and `((a+))+` defeats the
 * `[^()]` scoping. A blacklist cannot be made sound; these pin the allowlist
 * that replaced it.
 *
 * `MAX_PATTERN_INPUT_LENGTH = 8192` never helped: exponential growth peaks
 * around 26 characters, three orders of magnitude below the cap.
 */
const REDOS_BYPASSES: ReadonlyArray<readonly [string, string]> = [
  ['^(a+)+$', 'nested quantifier — the only shape the old screen caught'],
  ['^(a|a)+$', 'BYPASSED the old screen; 1739 ms on a 26-char subject'],
  ['^(a|a)*$', 'BYPASSED the old screen; 1411 ms on a 26-char subject'],
  ['^((a+))+$', 'BYPASSED the old screen; 412 ms — nested groups beat [^()]'],
  ['^(a|ab)*c$', 'BYPASSED the old screen; ambiguous alternation'],
  ['^(?:a|a)+$', 'BYPASSED the old screen; non-capturing group'],
];

/** Patterns that are genuinely dangerous AND were already blocked. Rejecting
 *  them stays correct — but a rejection must be VISIBLE, see the F2 block. */
const REDOS_ALREADY_BLOCKED = [
  '^([a-z]+)*$',
  '^(\\w+\\s?)*$',
  '^(a{1,10}){1,10}b$',
];

/**
 * Every pattern in the FIRST real manifest written against this feature
 * (byte5ai/omadia-google-workspace#1). These MUST keep working — the feature is
 * worthless if the manifest it exists for cannot express what it needs.
 *
 * `^…\.[A-Za-z]{2,}$` is here because the allowlist used to refuse `{n,}` while
 * accepting `+`, which is the same construct. The manifest author had to write
 * `[A-Za-z][A-Za-z]+` — identical language, worse to read — to get it past the
 * screen. See {@link screenPatternSource}.
 */
const REALISTIC_PATTERNS = [
  SA_EMAIL_PATTERN,
  '^-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$',
  '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,63}$',
];

describe('OM-17 / F1 — allowlist grammar replaces the bypassable blacklist', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  for (const [pattern, why] of REDOS_BYPASSES) {
    it(`rejects ${pattern} (${why})`, () => {
      assert.notEqual(
        screenPatternSource(pattern),
        null,
        `${pattern} was accepted by the screen`,
      );
      assert.equal(compileSetupPattern(pattern, 'test'), null);
    });
  }

  for (const pattern of REDOS_ALREADY_BLOCKED) {
    it(`still rejects the already-known-bad ${pattern}`, () => {
      assert.notEqual(screenPatternSource(pattern), null);
    });
  }

  for (const pattern of REALISTIC_PATTERNS) {
    it(`ACCEPTS the realistic pattern ${pattern}`, () => {
      assert.equal(
        screenPatternSource(pattern),
        null,
        `${pattern} must not be rejected — the feature is useless without it`,
      );
      assert.ok(compileSetupPattern(pattern, 'test') instanceof RegExp);
    });
  }

  it('rejects backreferences and quantified lookaround', () => {
    assert.notEqual(screenPatternSource('^(a)\\1$'), null);
    assert.notEqual(screenPatternSource('^\\k<n>$'), null);
    assert.notEqual(screenPatternSource('^(?=.*a+)b$'), null);
  });

  it('rejects group nesting deeper than 2 and oversized {n,m}', () => {
    assert.notEqual(screenPatternSource('^(((a)))b$'), null);
    assert.notEqual(screenPatternSource('a{1,5000}'), null);
    assert.equal(screenPatternSource('^\\d{3}-\\d{4}$'), null);
  });

  it('accepts UNQUANTIFIED alternation — a plain enum check is fine', () => {
    assert.equal(screenPatternSource('^(?:prod|dev|staging)$'), null);
  });
});

// ---------------------------------------------------------------------------
// F5 — the allowlist refused `{n,}` while accepting `+`, which IS `{1,}`
// ---------------------------------------------------------------------------

/**
 * The rule bought no safety and only cost manifest authors: the very first
 * realistic pattern written against this feature — an email TLD,
 * `^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$` — was refused and had to ship as
 * `[A-Za-z][A-Za-z]+`, which is the identical language spelled worse.
 *
 * Counted quantifiers are now screened by exactly the rules `*` and `+` go
 * through: refused on a group containing alternation or another quantifier,
 * accepted on a simple atom or character class, with a numeric cap on both
 * bounds. The `REDOS_BYPASSES` table above is the other half of this change —
 * every hostile shape there must still be rejected, and each of those shapes
 * would also be rejected written as `{n,}` (see below).
 */
describe('OM-17 / F5 — `{n,}` is screened exactly like the `+` it is equal to', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['^[A-Za-z]{2,}$', 'open-ended counted repetition on a character class'],
    ['^a{2,}$', 'open-ended counted repetition on a literal'],
    ['^[A-Za-z]{2,63}$', 'the bounded form of the same thing'],
    ['^\\d{4}$', 'an exact count'],
    ['^[a-z]{0,}$', '`{0,}` — i.e. `*`'],
    ['^[a-z]{2,}?$', 'the lazy form'],
    ['^a{100}$', 'exactly at the counted-repetition cap'],
    ['^a{100,}$', 'the cap applied to the MINIMUM of an open-ended form'],
  ];

  for (const [pattern, why] of ACCEPTED) {
    it(`accepts ${pattern} (${why})`, () => {
      assert.equal(
        screenPatternSource(pattern),
        null,
        `${pattern} must be accepted — it is exactly what \`+\`/\`*\` express`,
      );
      assert.ok(compileSetupPattern(pattern, 'test') instanceof RegExp);
    });
  }

  const REJECTED: ReadonlyArray<readonly [string, string]> = [
    ['^a{101}$', 'one above the counted-repetition cap'],
    ['^a{101,}$', 'the MINIMUM of an open-ended form is capped too — without '
      + 'that, allowing `{n,}` would hand a manifest an unbounded knob'],
    ['^a{1,101}$', 'upper bound above the cap'],
    ['^a{100000,}$', 'an absurd open-ended minimum'],
    // The hostile shapes from REDOS_BYPASSES, rewritten with `{n,}`. Allowing
    // the counted spelling must not open a door the `+` spelling keeps shut.
    ['^(a|a){1,}$', '`^(a|a)+$` in counted clothing — quantified alternation'],
    ['^(a{1,})+$', '`^(a+)+$` in counted clothing — nested quantifier'],
    ['^(a{1,}){1,}$', 'both halves counted'],
    ['^((a{2,})){2,}$', '`^((a+))+$` in counted clothing — laundering by nesting'],
    ['^(?:a|a){2,}$', 'non-capturing group does not launder it either'],
    // No `.*` here on purpose — the counted quantifier must be the ONLY thing
    // that trips the lookaround rule, otherwise the case proves nothing.
    ['^(?=a{1,})b$', 'lookaround containing an open-ended counted repetition'],
  ];

  for (const [pattern, why] of REJECTED) {
    it(`still rejects ${pattern} (${why})`, () => {
      assert.notEqual(
        screenPatternSource(pattern),
        null,
        `${pattern} was accepted by the screen`,
      );
      assert.equal(compileSetupPattern(pattern, 'test'), null);
    });
  }

  it('an accepted `{n,}` pattern MATCHES correctly end to end', async () => {
    // Compiling is not the bar — the pattern has to do its job. This is the
    // literal OM-17 confusion, on the field the real manifest declares with
    // `{2,}`: a plausible-looking address must pass and a password must not.
    const field = {
      key: 'gw_impersonated_user',
      pattern: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$',
    };
    assert.equal(
      await checkSetupFieldPattern(field, 'tester@customer-company.de'),
      null,
    );
    assert.equal(await checkSetupFieldPattern(field, 'admin@byte5.io'), null);
    // `{2,}` really is open-ended: a long TLD must pass, where `{2}` would not.
    assert.equal(
      await checkSetupFieldPattern(field, 'ops@example.technology'),
      null,
    );
    // …and it really is a MINIMUM of two: a 1-char TLD must fail.
    assert.equal(
      (await checkSetupFieldPattern(field, 'ops@example.x'))?.field,
      'gw_impersonated_user',
    );
    // What the tester actually typed into a field like this.
    assert.equal(
      (await checkSetupFieldPattern(field, 'hunter2'))?.field,
      'gw_impersonated_user',
    );
  });

  it('the bounded `{2,63}` form matches the same way, and enforces its cap', async () => {
    const field = { key: 'email', pattern: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,63}$' };
    assert.equal(await checkSetupFieldPattern(field, 'a@b.de'), null);
    assert.equal(
      (await checkSetupFieldPattern(field, `a@b.${'x'.repeat(64)}`))?.field,
      'email',
    );
  });

  it('a whole realistic manifest field set loads with every pattern intact', async () => {
    // Mirrors the field set of the first real manifest written against this
    // feature. Inlined rather than read from that repo: the assertion is about
    // OUR screen, and a test must not depend on a sibling checkout existing.
    const plugin = adaptManifestV1({
      schema_version: '1',
      identity: { id: 'gw', name: 'Google Workspace', version: '1.0.0' },
      setup: {
        fields: REALISTIC_PATTERNS.map((pattern, idx) => ({
          key: `f${String(idx)}`,
          type: 'secret',
          pattern,
          pattern_hint: { en: 'en hint', de: 'de hint' },
        })),
      },
    });
    assert.equal(plugin?.setup_fields.length, REALISTIC_PATTERNS.length);
    for (const f of plugin?.setup_fields ?? []) {
      assert.equal(
        f.pattern_unavailable,
        undefined,
        `${String(f.pattern)} came back pattern_unavailable`,
      );
      assert.ok(f.pattern, `${f.key} lost its pattern`);
    }
    assert.deepEqual(getPatternProblems(), []);
  });
});

describe('OM-17 / F1 — hard execution bound on the match itself', () => {
  after(async () => {
    await shutdownPatternWorker();
  });

  it('bounds a hostile pattern that somehow reached the matcher', async () => {
    // Constructed directly, DELIBERATELY bypassing the allowlist: (b) is not
    // the last line of defence, (a) is. `^(a|a)*$` against 30 a's + b is the
    // executed 1411 ms case. An in-process timer could not stop this — only
    // terminating the worker thread can.
    const hostile = /^(a|a)*$/;
    const started = Date.now();
    const outcome = await matchWithBudget(hostile, `${'a'.repeat(30)}b`);
    const elapsed = Date.now() - started;
    assert.equal(outcome, 'overrun');
    assert.ok(
      elapsed < 2000,
      `budget not enforced: match took ${String(elapsed)}ms`,
    );
  });

  it('recovers after a terminated worker — the next match still works', async () => {
    assert.equal(await matchWithBudget(/^a+$/, 'aaa'), 'match');
    assert.equal(await matchWithBudget(/^a+$/, 'bbb'), 'no-match');
  });

  it('the allowlist refuses the hostile pattern before it ever reaches a field', async () => {
    // Documented, deliberate layering: (b) refuses the pattern at compile time,
    // so the FIELD-level check fails OPEN here rather than fail-closed. That is
    // exactly why F2's visibility flag has to exist. Assert the real behaviour,
    // not a comfortable one.
    resetSetupPatternCache();
    const violation = await checkSetupFieldPattern(
      { key: 'k', pattern: '^(a|a)*$' },
      `${'a'.repeat(30)}b`,
    );
    assert.equal(violation, null);
    assert.equal(compileSetupPattern('^(a|a)*$', 'k'), null);
  });
});

// ---------------------------------------------------------------------------
// F2 — a refused pattern must never silently disable validation
// ---------------------------------------------------------------------------

describe('OM-17 / F2 — a refused pattern is SURFACED, not just logged', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  it('flags the catalog field as pattern_unavailable', () => {
    const plugin = adaptManifestV1({
      schema_version: '1',
      identity: { id: 'test-plugin', name: 'Test', version: '1.0.0' },
      setup: { fields: [{ key: 'k', type: 'secret', pattern: '^(a|a)+$' }] },
    });
    const f = plugin?.setup_fields[0];
    assert.equal(f?.pattern, undefined);
    assert.equal(
      f?.pattern_unavailable,
      true,
      'a dropped pattern must be visible to the operator, not only in a log line',
    );
  });

  it('does NOT flag a field whose pattern was accepted', () => {
    const plugin = adaptManifestV1({
      schema_version: '1',
      identity: { id: 'test-plugin', name: 'Test', version: '1.0.0' },
      setup: { fields: [{ key: 'k', type: 'secret', pattern: PEM_PATTERN }] },
    });
    assert.equal(plugin?.setup_fields[0]?.pattern_unavailable, undefined);
  });

  it('flags the INSTALL-schema projection too', () => {
    const schema = extractSetupSchema({
      plugin: { id: 'p', name: 'P', version: '1' } as never,
      manifest: {
        setup: { fields: [{ key: 'k', type: 'secret', pattern: '^(a+)+$' }] },
      },
      source_path: '<test>',
      source_kind: 'manifest-v1',
    } as unknown as PluginCatalogEntry);
    const f = schema?.fields[0];
    assert.equal(f?.pattern, undefined);
    assert.equal(f?.pattern_unavailable, true);
  });

  it('records the reason in the problem registry', () => {
    compileSetupPattern('^(a|a)+$', 'my-plugin/my_field');
    const hit = getPatternProblems().find(
      (p) => p.context === 'my-plugin/my_field',
    );
    assert.ok(hit, 'the refusal must be diagnosable');
    assert.match(hit.reason, /alternation/);
  });
});

// ---------------------------------------------------------------------------
// F3 — client and server must agree that an EMPTY value is "not set"
// ---------------------------------------------------------------------------

describe('OM-17 / F3 — an optional patterned field can be cleared', () => {
  let h: Harness | undefined;
  beforeEach(() => {
    resetSetupPatternCache();
  });
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('unit: an empty value never violates a pattern', async () => {
    assert.equal(
      await checkSetupFieldPattern(
        { key: 'api_key', pattern: '^sk-[A-Za-z0-9]+$' },
        '',
      ),
      null,
    );
  });

  it('end to end: clearing an optional patterned field returns 200', async () => {
    // The reported failure: the client short-circuited on `value.length === 0`
    // and showed no error, the server did NOT and tested `""` against
    // `^sk-[A-Za-z0-9]+$` → 400. The optional field could never be cleared.
    h = await makeHarness([
      {
        key: 'api_key',
        type: 'secret',
        required: false,
        pattern: '^sk-[A-Za-z0-9]+$',
      },
    ]);
    const seeded = await patchSecrets(h, { api_key: 'sk-abc123' });
    assert.equal(seeded.status, 200);

    const cleared = await patchSecrets(h, { api_key: '' });
    assert.equal(
      cleared.status,
      200,
      `clearing must succeed, got ${JSON.stringify(cleared.body)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// F4 — the server was doing a SUBSTRING match; HTML `pattern=` is anchored
// ---------------------------------------------------------------------------

describe('OM-17 / F4 — server anchoring matches HTML `pattern=` semantics', () => {
  let h: Harness | undefined;
  beforeEach(() => {
    resetSetupPatternCache();
  });
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it('"my password is 1234" FAILS the pattern [0-9]{4}', async () => {
    // Unanchored `regex.test()` is a substring match, so this passed before —
    // near-zero enforcement on exactly the credential-confusion case.
    const violation = await checkSetupFieldPattern(
      { key: 'pin', pattern: '[0-9]{4}' },
      'my password is 1234',
    );
    assert.equal(violation?.field, 'pin');
  });

  it('a bare "1234" still passes [0-9]{4}', async () => {
    assert.equal(
      await checkSetupFieldPattern({ key: 'pin', pattern: '[0-9]{4}' }, '1234'),
      null,
    );
  });

  it('end to end: the substring smuggle is rejected by the route', async () => {
    h = await makeHarness([{ key: 'pin', type: 'secret', pattern: '[0-9]{4}' }]);
    const { status } = await patchSecrets(h, { pin: 'my password is 1234' });
    assert.equal(status, 400);
  });

  it('anchorPatternSource wraps only a pattern with NO anchor of its own', () => {
    assert.equal(anchorPatternSource('[0-9]{4}'), '^(?:[0-9]{4})$');
    // Half-anchored patterns are left alone on purpose: forcing `$` onto this
    // prefix check would reject every real multi-line PEM block.
    assert.equal(anchorPatternSource(PEM_PATTERN), PEM_PATTERN);
    assert.equal(anchorPatternSource('^abc$'), '^abc$');
    // A trailing ESCAPED dollar is a literal, not an anchor.
    assert.equal(anchorPatternSource('abc\\$'), '^(?:abc\\$)$');
  });

  it('a PEM prefix pattern still accepts a real multi-line key', async () => {
    const pem = [
      `${PEM_PATTERN.slice(1)}`,
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
      PEM_PATTERN.slice(1).replace('BEGIN', 'END'),
    ].join('\n');
    assert.equal(
      await checkSetupFieldPattern(
        { key: 'gw_sa_private_key', pattern: '^-----BEGIN [A-Z ]*PRIVATE KEY-----' },
        pem,
      ),
      null,
    );
  });
});

/**
 * #607 — the budget has to bound the MATCH, not the worker's birth.
 *
 * The shipped first revision started its clock at dispatch and waited only for
 * the worker's `'online'` event. `'online'` fires when the THREAD starts, which
 * is well before the worker module has been evaluated — so module evaluation
 * was charged to the match budget. Measured on a cold process: 838 ms for a
 * trivial email pattern. Under `node --import tsx` — which is exactly how this
 * suite runs — every call overran, because the worker re-runs tsx's loader.
 *
 * That is the point of running these assertions here rather than in a
 * hand-driven script: if the handshake regresses, the tsx path breaks first and
 * these tests are the ones that notice.
 */
describe('#607 — the match budget must not include worker startup', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  after(async () => {
    await shutdownPatternWorker();
  });

  it('a trivial match on a COLD worker stays well inside the budget', async () => {
    // Force a genuinely cold worker: this is the 838 ms case.
    await shutdownPatternWorker();
    const field = {
      key: 'gw_subject_default',
      pattern: '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,63}$',
    };
    const started = Date.now();
    const violation = await checkSetupFieldPattern(
      field,
      'assistant@te-printline.de',
    );
    const elapsed = Date.now() - started;

    assert.equal(violation, null, 'a valid address was rejected on a cold worker');
    // The whole call may legitimately take longer than the budget — it includes
    // thread creation. What must NOT happen is the value being rejected, or the
    // pattern being blamed, because of that startup cost.
    assert.deepEqual(
      getPatternProblems(),
      [],
      `a healthy pattern was marked unusable after a ${String(elapsed)}ms cold start`,
    );
  });

  it('warmPatternWorker is idempotent and leaves the worker usable', async () => {
    await shutdownPatternWorker();
    await warmPatternWorker();
    await warmPatternWorker();
    assert.equal(await matchWithBudget(/^a+$/, 'aaa'), 'match');
  });

  it('repeated cold starts never reject a valid value', async () => {
    const field = { key: 'k', pattern: '^[a-z]+@[a-z]+\\.[a-z]{2,63}$' };
    for (let i = 0; i < 3; i += 1) {
      await shutdownPatternWorker();
      assert.equal(
        await checkSetupFieldPattern(field, 'ops@example.de'),
        null,
        `cold start #${String(i + 1)} rejected a valid value`,
      );
    }
    assert.deepEqual(getPatternProblems(), []);
  });
});

/**
 * #607 — an overrun is evidence about ONE execution, not about the pattern.
 *
 * `getPatternProblems()` is what surfaces "this field declares a format check
 * that could not be applied" to the operator, for the life of the process. The
 * first revision wrote into it on the very first overrun, so a single unlucky
 * match permanently mislabelled a healthy pattern. The write still fails closed
 * immediately; only the durable verdict now waits for corroboration.
 */
describe('#607 — one overrun must not permanently blame the pattern', () => {
  beforeEach(() => {
    resetSetupPatternCache();
  });

  after(async () => {
    await shutdownPatternWorker();
  });

  /**
   * Passes the allowlist — deliberately. Every quantifier sits on a bare
   * character class, so no "quantified group containing a quantifier" rule
   * fires; the cost comes from four adjacent unbounded runs splitting a
   * non-matching subject every possible way. This is precisely the shape the
   * allowlist cannot catch and the execution bound must.
   *
   * Calibrated by measurement on node 22, first call in a fresh process:
   *
   *   'a'*100 + '!' →   10 ms      'abcd' → 0 ms
   *   'a'*200 + '!' →  125 ms
   *   'a'*400 + '!' → 1604 ms
   *
   * SLOW_SUBJECT sits an order of magnitude past the 250 ms budget so the
   * overrun is not a race, and FAST_SUBJECT completes immediately — the SAME
   * pattern, which is what makes the reset test meaningful (strikes are keyed
   * by context AND pattern).
   *
   * A NOTE ON MEASURING THIS, because it cost a round: V8 caches compiled
   * regexes by source, so timing a subject AFTER another subject has already
   * run the same source reports the warm number. An earlier revision of this
   * test picked a subject that measured 0.011 ms that way and was 2152 ms on a
   * cold first call. Always measure the first call in a fresh process.
   */
  const SLOW_PATTERN = '^[a-z]+[a-z]+[a-z]+[a-z]+$';
  const SLOW_SUBJECT = `${'a'.repeat(500)}!`;
  const FAST_SUBJECT = 'abcd';

  it('the allowlist really does accept this pattern (so the bound is what stops it)', () => {
    assert.equal(screenPatternSource(SLOW_PATTERN), null);
  });

  it('the first overrun rejects the write but does NOT record a problem', async () => {
    const field = { key: 'slow', pattern: SLOW_PATTERN };
    const violation = await checkSetupFieldPattern(field, SLOW_SUBJECT);
    assert.equal(violation?.field, 'slow', 'the write must still fail closed');
    assert.deepEqual(
      getPatternProblems(),
      [],
      'a single overrun must not mark the pattern unusable',
    );
  });

  it('three consecutive overruns do record a problem', async () => {
    const field = { key: 'slow', pattern: SLOW_PATTERN };
    for (let i = 0; i < 3; i += 1) {
      await checkSetupFieldPattern(field, SLOW_SUBJECT);
    }
    const problems = getPatternProblems();
    assert.equal(problems.length, 1, 'the pattern should now be reported');
    assert.equal(problems[0]?.context, 'slow');
    assert.match(String(problems[0]?.reason), /times in a row/);
  });

  it('a completed match resets the strike count', async () => {
    const slow = { key: 'slow', pattern: SLOW_PATTERN };
    // Two strikes...
    await checkSetupFieldPattern(slow, SLOW_SUBJECT);
    await checkSetupFieldPattern(slow, SLOW_SUBJECT);
    // ...then a value the SAME pattern disposes of immediately, proving the
    // pattern was never the problem.
    assert.equal(
      await checkSetupFieldPattern(slow, FAST_SUBJECT),
      null,
      'expected a clean match, not an overrun',
    );
    assert.deepEqual(
      getPatternProblems(),
      [],
      'the run was broken by a completed match',
    );
    // A third slow value is therefore only strike one again — without the
    // reset this call would be the third and would record a problem.
    await checkSetupFieldPattern(slow, SLOW_SUBJECT);
    assert.deepEqual(getPatternProblems(), []);
  });
});
